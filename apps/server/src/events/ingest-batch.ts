import {
  itemDeltaText,
  mergeItemDeltas,
  type RawEventEnvelope,
  type RunnerEventMessage,
} from "@codeden/contracts";
import type { Db } from "../db/client";
import { runnerState } from "../db/schema";
import {
  lastAckedSeq,
  type RunnerEventSource,
  runnerEventSessionId,
  runnerEventToNewEvents,
  untrustedEventRefusal,
} from "./ingest";
import type { EventStore } from "./store";

export interface BatchIngestResult {
  /** Server events stored, in order. */
  events: RawEventEnvelope[];
  /** Seq to acknowledge to the runner: the highest in the batch. */
  ackSeq: number;
  /** The runner events written (after merging), refused ones excluded. */
  stored: RunnerEventMessage[];
  /** Events of an untrusted runner that were dropped (acknowledged, never stored), and why. */
  refused: { msg: RunnerEventMessage; reason: string }[];
}

/**
 * Most characters of streamed text one merged delta holds: the runner's own cap for the deltas
 * it merges (`DELTA_MAX_CHARS` in `apps/runner/src/delta-batcher.ts`), so a stored event, and
 * what every UI client is sent, stays as small as the runner's.
 */
export const MERGED_DELTA_MAX_CHARS = 16 * 1024;

/**
 * Merge streamed deltas that arrived together: per session, a delta that extends the same item
 * the same way as that session's previous delta in the batch (`mergeItemDeltas`) joins it, as
 * the runner's own batching does, while the merged text stays within `maxChars`; the delta that
 * would take it past starts the next merged one. Any other event of the session ends its run of
 * deltas; an event of no session ends every run, so it never falls behind a delta that came
 * after it. Order within a session is kept.
 */
export function mergeStreamedDeltas(
  msgs: RunnerEventMessage[],
  maxChars = MERGED_DELTA_MAX_CHARS,
): RunnerEventMessage[] {
  const out: RunnerEventMessage[] = [];
  /** Session id -> its delta in `out` that a later one may join, and that delta's length. */
  const open = new Map<string, { at: number; chars: number }>();
  for (const msg of msgs) {
    const { event } = msg;
    if (event.kind === "agent" && event.event.type === "item.delta") {
      const chars = itemDeltaText(event.event.delta).length;
      const run = open.get(event.sessionId);
      const prev = run && run.chars + chars <= maxChars ? out[run.at] : undefined;
      const merged =
        prev?.event.kind === "agent" && prev.event.event.type === "item.delta"
          ? mergeItemDeltas(prev.event.event, event.event)
          : undefined;
      if (run && merged) {
        out[run.at] = { ...msg, event: { ...event, event: merged } };
        run.chars += chars;
      } else {
        open.set(event.sessionId, { at: out.length, chars });
        out.push(msg);
      }
      continue;
    }
    const sessionId = runnerEventSessionId(event);
    if (sessionId === null) open.clear();
    else open.delete(sessionId);
    out.push(msg);
  }
  return out;
}

/**
 * `ingestRunnerEvent` for every event that arrived together (§4.2, §6): one transaction stores
 * them all, their projections and the runner's acked seq, so a burst of streamed deltas costs one
 * commit and one rewrite of each growing item instead of one per delta. Events at or below the
 * stored ack position (replays) are skipped; an untrusted runner's events for sessions not
 * routed to it are dropped but acknowledged, as with `ingestRunnerEvent`.
 */
export function ingestRunnerEvents(
  db: Db,
  store: EventStore,
  runnerId: string,
  msgs: RunnerEventMessage[],
  source: RunnerEventSource = {},
): BatchIngestResult {
  const ackSeq = msgs.reduce((m, msg) => Math.max(m, msg.seq), 0);
  const acked = lastAckedSeq(db, runnerId);
  const fresh = mergeStreamedDeltas(msgs.filter((msg) => msg.seq > acked));
  const result: BatchIngestResult = { events: [], ackSeq, stored: [], refused: [] };
  if (fresh.length === 0) return result;
  const now = new Date().toISOString();
  // A pty whose exit is stored earlier in this batch owns nothing after it, as when each event
  // is stored on its own (the guard forgets it only once the batch commits).
  const exited = new Set<string>();
  const { ownsPty } = source;
  const ownsLivePty = ownsPty && ((ptyId: string) => !exited.has(ptyId) && ownsPty(ptyId));
  result.events = store.appendSteps(
    fresh.map((msg) => (reader) => {
      const reason = source.untrusted
        ? untrustedEventRefusal(reader, msg.event, runnerId, ownsLivePty)
        : null;
      if (reason) {
        result.refused.push({ msg, reason });
        return [];
      }
      if (msg.event.kind === "pty.exited") exited.add(msg.event.ptyId);
      result.stored.push(msg);
      return runnerEventToNewEvents(reader, msg, runnerId, source.recordId);
    }),
    (tx) => {
      tx.insert(runnerState)
        .values({ runnerId, lastAckedSeq: ackSeq, updatedAt: now })
        .onConflictDoUpdate({
          target: runnerState.runnerId,
          set: { lastAckedSeq: ackSeq, updatedAt: now },
        })
        .run();
    },
  );
  return result;
}
