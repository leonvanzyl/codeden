import type { RunnerEvent, SessionStatus } from "@codeden/contracts";
import { Draft } from "./draft";
import { closeInbox, openRunFailed, runFailedAgain, runFailedInbox } from "./items";
import type { Mutation, ProjectionReader } from "./types";

type ProcessEvent = Extract<RunnerEvent, { kind: "session.process" }>;

const FINAL: ReadonlySet<SessionStatus> = new Set(["completed", "stopped", "failed"]);

/**
 * Provider process lifecycle (runner `session.process` events) -> projection changes. A crash
 * fails the session and raises a `run_failed` inbox item (or updates the session's open one: one
 * item per run); a normal exit stops it; an exit
 * because the runner is going away keeps it resumable (`interrupted` if a turn was cut off). Either way,
 * open questions and approvals can no longer be answered and are dismissed. Pure.
 */
export function reduceProcessEvent(
  reader: ProjectionReader,
  event: ProcessEvent,
  runnerSeq: number,
  ts: string,
): Mutation[] {
  if (event.state !== "crashed" && event.state !== "exited") return [];
  const d = new Draft(reader);
  const record = d.getSession(event.sessionId);
  if (!record) return [];
  const { session } = record;

  for (const inbox of d.openInboxForSession(session.id)) {
    if (inbox.kind !== "approval" && inbox.kind !== "question") continue;
    d.putInbox(closeInbox(inbox, "dismissed", { status: "cancelled", reason: event.state }, ts));
  }

  if (event.state === "exited" && event.reason === "runner_exit") {
    // The runner is draining or shutting down: the session stays resumable (§4.2). A turn
    // that was cut off is marked interrupted so recovery continues it after the restart.
    const cutOff =
      event.interruptedTurn || session.status === "running" || session.status === "waiting";
    if (cutOff && !FINAL.has(session.status) && session.status !== "interrupted") {
      d.putSession({ ...session, status: "interrupted", updatedAt: ts }, record.usage);
    }
    return d.mutations();
  }

  if (event.state === "crashed") {
    // The provider refused to open the session: kept with it, so the factory can tell a CLI too
    // old to run (`kind: "setup"`) or signed out from a session that died.
    const refused = event.error?.code === "open_failed" ? event.error : undefined;
    if (!FINAL.has(session.status) || refused) {
      d.putSession(
        {
          ...session,
          status: FINAL.has(session.status) ? session.status : "failed",
          ...(refused ? { startError: refused } : {}),
          updatedAt: ts,
        },
        record.usage,
      );
    }
    const message = event.error?.message ?? "The agent process crashed";
    // One item per run: a session that fails again (a Retry refused at open) updates its open one.
    const open = openRunFailed(d.openInboxForSession(session.id));
    if (open) d.putInbox(runFailedAgain(open, message, ts));
    else {
      const id = `inbox:${session.id}:process:${runnerSeq}`;
      d.putInbox(runFailedInbox(session, id, message, session.rootThreadId, ts));
    }
  } else if (!FINAL.has(session.status)) {
    d.putSession(
      { ...session, status: "stopped", endedAt: session.endedAt ?? ts, updatedAt: ts },
      record.usage,
    );
  }
  return d.mutations();
}
