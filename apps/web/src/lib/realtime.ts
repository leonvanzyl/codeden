import {
  type EventEnvelope,
  EventEnvelope as EventEnvelopeSchema,
  GITHUB_EVENT_TYPES,
  isAgentEnvelope,
  type Snapshot,
} from "@codeden/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useConnectionStore } from "@/stores/connection";
import { useTranscriptsStore } from "@/stores/transcripts";
import type { CodeDenClient } from "./api/client";
import { invalidateAutomations } from "./automations";
import { invalidateFactory } from "./factory";
import { snapshotKey } from "./queries";
import { applyDomainEvent } from "./snapshot-reducer";
import { updatesKey } from "./updates";

type EnvelopeListener = (env: EventEnvelope) => void;
const GITHUB_EVENTS = new Set<string>(GITHUB_EVENT_TYPES);
const listeners = new Set<EnvelopeListener>();

/** Subscribe to every parsed live event (toasts, notifications, cache invalidation). */
export function onLiveEvent(listener: EnvelopeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Queries that depend on a session's working tree, refreshed when it changes. */
function invalidateWorkbench(queryClient: QueryClient, env: EventEnvelope): void {
  if (env.type === "checkpoint.created") {
    const id = env.payload.checkpoint.sessionId;
    for (const key of ["diff", "files", "file", "git-status"]) {
      void queryClient.invalidateQueries({ queryKey: [key, id] });
    }
  }
  // Orchestration and GitHub views (§8.4, §9) are queries over server projections.
  if (env.type === "conflict.created")
    void queryClient.invalidateQueries({ queryKey: ["conflicts"] });
  if (
    (env.type === "inbox.created" || env.type === "inbox.updated") &&
    env.payload.item.kind === "conflict"
  )
    void queryClient.invalidateQueries({ queryKey: ["conflicts"] });
  if (env.type === "session.created" || env.type === "session.updated")
    void queryClient.invalidateQueries({ queryKey: ["project-status"] });
  if (GITHUB_EVENTS.has(env.type)) void queryClient.invalidateQueries({ queryKey: ["github"] });
  if (env.type === "message.queued" || env.type === "message.dequeued") {
    const id =
      env.type === "message.queued" ? env.payload.message.sessionId : env.payload.sessionId;
    void queryClient.invalidateQueries({ queryKey: ["session-detail", id] });
  }
}

/**
 * Realtime (§6): load the snapshot, subscribe from its seq, apply domain events to the snapshot
 * cache, and reload on `resync`. Transcripts are watched per session (`useTranscript`); the
 * mock client also sends agent events here, which go to the transcript store.
 */
export function startRealtime(client: CodeDenClient, queryClient: QueryClient): () => void {
  const conn = useConnectionStore.getState;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;
  conn().setSocket("connecting");
  const offState = client.onConnectionChange((state) => conn().setSocket(state));

  const apply = (raw: unknown) => {
    const parsed = EventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return; // Unknown event types are skipped (newer server).
    const env = parsed.data;
    if (isAgentEnvelope(env)) {
      useTranscriptsStore.getState().apply(env.sessionId, env.payload, env.seq, env.ts);
    } else {
      queryClient.setQueryData(snapshotKey, (s: Snapshot | undefined) =>
        s ? applyDomainEvent(s, env) : s,
      );
      invalidateWorkbench(queryClient, env);
      invalidateAutomations(queryClient, env);
      invalidateFactory(queryClient, env);
    }
    if (env.seq > conn().seq) conn().setSeq(env.seq);
    for (const l of listeners) l(env);
  };

  const load = () =>
    queryClient.fetchQuery({
      queryKey: snapshotKey,
      queryFn: () => client.getSnapshot(),
      staleTime: 0,
    });

  const connect = (fromSeq: number) => {
    unsubscribe?.();
    unsubscribe = client.subscribe(fromSeq, (msg) => {
      switch (msg.type) {
        case "runner":
          conn().setRunner(msg.runner, msg.runners);
          // Pickers read providers and their models from the snapshot: keep it current.
          queryClient.setQueryData(snapshotKey, (s: Snapshot | undefined) =>
            s ? { ...s, runner: msg.runner, runners: msg.runners ?? s.runners } : s,
          );
          break;
        case "update":
          queryClient.setQueryData(updatesKey, msg.update);
          break;
        case "events":
          for (const e of msg.events) apply(e);
          break;
        case "resync":
          // The server can't replay the gap: reload everything and resubscribe.
          void load().then((snap) => {
            if (stopped) return;
            conn().setSeq(snap.seq);
            void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "snapshot" });
            connect(snap.seq);
          });
          break;
        default:
          break;
      }
    });
  };

  load()
    .then((snap) => {
      if (stopped) return;
      conn().setAuth("ok");
      conn().setSeq(snap.seq);
      conn().setRunner(snap.runner, snap.runners);
      connect(snap.seq);
    })
    .catch(() => conn().setSocket("closed"));

  return () => {
    stopped = true;
    offState();
    unsubscribe?.();
  };
}
