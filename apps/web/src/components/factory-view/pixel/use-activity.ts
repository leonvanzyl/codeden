import { type Item, isAgentEnvelope } from "@codeden/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useClient } from "@/lib/api";
import { onLiveEvent } from "@/lib/realtime";
import { useConnectionStore } from "@/stores/connection";
import {
  type AgentActivity,
  activityOf,
  NO_ACTIVITY,
  nextChange,
  noteActivity,
  tickActivity,
} from "./activity";

/**
 * The live activity of the agents on screen (#264), for their thought bubbles. It keeps one
 * small state per session (the bubble and the last few activities) and re-renders only what
 * reads it, on a new activity or when a bubble's time comes, never on a timer that polls.
 */
export class ActivityStore {
  private bySession = new Map<string, AgentActivity>();
  private listeners = new Set<() => void>();
  private version = 0;
  private timer = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Takes in a transcript item of a session. */
  note(sessionId: string, item: Item) {
    const activity = activityOf(item);
    if (!activity) return;
    const before = this.bySession.get(sessionId) ?? NO_ACTIVITY;
    const after = noteActivity(before, activity, this.clock());
    if (after === before) return;
    this.bySession.set(sessionId, after);
    this.changed();
  }

  get(sessionId: string | null): AgentActivity {
    return (sessionId && this.bySession.get(sessionId)) || NO_ACTIVITY;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever a bubble does. */
  getVersion = () => this.version;

  dispose() {
    window.clearTimeout(this.timer);
    this.listeners.clear();
  }

  private changed() {
    this.version += 1;
    for (const l of this.listeners) l();
    this.schedule();
  }

  /** Wakes up when the next bubble shows, starts to fade, or goes. */
  private schedule() {
    window.clearTimeout(this.timer);
    const now = this.clock();
    let next = Number.POSITIVE_INFINITY;
    for (const s of this.bySession.values()) next = Math.min(next, nextChange(s, now) ?? next);
    if (next === Number.POSITIVE_INFINITY) return;
    this.timer = window.setTimeout(() => this.tick(), Math.max(16, next - now));
  }

  private tick() {
    const now = this.clock();
    for (const [id, s] of this.bySession) this.bySession.set(id, tickActivity(s, now));
    this.changed();
  }
}

/**
 * Watches the given sessions' new transcript items, from now on: the server's per-session watch
 * sends only the rows that change after the current event, so no transcript is loaded (the mock
 * client sends agent events on the live stream instead). Older rows replayed by another watch of
 * the same session are skipped.
 */
export function useAgentActivity(sessionIds: readonly string[]): ActivityStore {
  const client = useClient();
  const store = useMemo(() => new ActivityStore(), []);
  useEffect(() => () => store.dispose(), [store]);
  const key = [...sessionIds].sort().join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;
    const watched = new Set(ids);
    const since = Date.now() - 5000;
    const offLive = onLiveEvent((env) => {
      if (!isAgentEnvelope(env) || !watched.has(env.sessionId)) return;
      const e = env.payload;
      if (e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed")
        store.note(env.sessionId, e.item);
    });
    const seq = useConnectionStore.getState().seq;
    const offs = ids.map((id) =>
      client.watchSession(id, seq, (msg) => {
        if (msg.type !== "transcript") return;
        for (const row of msg.items)
          if (Date.parse(row.updatedAt) >= since) store.note(id, row.item);
      }),
    );
    return () => {
      offLive();
      for (const off of offs) off();
    };
  }, [client, store, key]);
  return store;
}

/** Re-renders the caller whenever a bubble changes. */
export function useActivityVersion(store: ActivityStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}
