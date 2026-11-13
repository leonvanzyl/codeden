import type {
  AgentEvent,
  ConflictRecord,
  EventEnvelope,
  FactoryStatus,
  Item,
  ItemRecord,
  ServerToClientMessage,
  Session,
  SessionSnapshot,
  Snapshot,
} from "@codeden/contracts";
import { applyDomainEvent } from "@/lib/snapshot-reducer";
import { applyAgentEvent, type TranscriptState } from "@/lib/transcript/reducer";
import { conflicts, inboxItems, sessions } from "./fixtures/sessions";
import { checkoutTranscript } from "./fixtures/transcript-checkout";
import { a11yTranscript, orchestratorTranscript, searchTranscript } from "./fixtures/transcripts-a";
import {
  auditTranscript,
  depsTranscript,
  emptyFor,
  exportTranscript,
  pmStorefrontTranscript,
  webhooksTranscript,
} from "./fixtures/transcripts-b";
import { automations, projects, runner, runners, scheduled, settings } from "./fixtures/world";

type Listener = (msg: ServerToClientMessage) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DomainEventInit = DistributiveOmit<
  Exclude<EventEnvelope, { type: `agent.${string}` }>,
  "seq" | "ts"
>;

/**
 * The mock server's state. Every change goes through `emitDomain` / `emitAgent`, which apply
 * the same reducers the UI uses and broadcast the envelope, so the mock behaves like the real
 * event-sourced server.
 */
export class MockWorld {
  seq = 1000;
  snapshot: Snapshot;
  transcripts = new Map<string, TranscriptState>();
  conflicts: ConflictRecord[] = structuredClone(conflicts);
  factory = new Map<string, FactoryStatus>();
  files = new Map<string, string>();
  private log: EventEnvelope[] = [];
  private listeners = new Set<Listener>();

  constructor() {
    this.snapshot = {
      seq: this.seq,
      serverVersion: "0.1.0",
      generatedAt: new Date().toISOString(),
      settings: structuredClone(settings),
      projects: structuredClone(projects),
      sessions: structuredClone(sessions),
      inbox: structuredClone(inboxItems),
      automations: structuredClone(automations),
      scheduled: structuredClone(scheduled),
      runner,
      runners: structuredClone(runners),
    };
    const fixtures = [
      orchestratorTranscript,
      checkoutTranscript,
      searchTranscript,
      a11yTranscript,
      webhooksTranscript,
      depsTranscript,
      auditTranscript,
      pmStorefrontTranscript,
      exportTranscript,
    ];
    for (const t of fixtures) this.transcripts.set(t.sessionId, { ...t, seq: this.seq });
  }

  session(id: string): Session | undefined {
    return this.snapshot.sessions.find((s) => s.id === id);
  }

  transcript(sessionId: string): TranscriptState {
    let t = this.transcripts.get(sessionId);
    if (!t) {
      const threadId = this.session(sessionId)?.rootThreadId ?? `t-${sessionId}`;
      t = { ...emptyFor(sessionId, threadId), seq: this.seq };
      this.transcripts.set(sessionId, t);
    }
    return t;
  }

  item(sessionId: string, itemId: string): Item | undefined {
    return this.transcript(sessionId).items[itemId]?.item;
  }

  subscribe(fromSeq: number, listener: Listener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      listener({ type: "hello", protocolVersion: 1, serverVersion: "0.1.0", seq: this.seq });
      listener({ type: "runner", runner: this.snapshot.runner, runners: this.snapshot.runners });
      const missed = this.log.filter((e) => e.seq > fromSeq);
      if (missed.length > 0) listener({ type: "events", events: missed });
    });
    return () => this.listeners.delete(listener);
  }

  private broadcast(env: EventEnvelope) {
    this.log.push(env);
    if (this.log.length > 2000) this.log.splice(0, 500);
    for (const l of this.listeners) l({ type: "events", events: [env] });
  }

  emitDomain(init: DomainEventInit): void {
    this.seq += 1;
    const env = { ...init, seq: this.seq, ts: new Date().toISOString() } as EventEnvelope;
    this.snapshot = applyDomainEvent(this.snapshot, env);
    this.broadcast(env);
  }

  emitAgent(sessionId: string, event: AgentEvent): void {
    this.seq += 1;
    const ts = new Date().toISOString();
    const env = {
      seq: this.seq,
      ts,
      sessionId,
      type: `agent.${event.type}`,
      payload: event,
    } as EventEnvelope;
    this.transcripts.set(
      sessionId,
      applyAgentEvent(this.transcript(sessionId), event, { seq: this.seq, ts }),
    );
    this.broadcast(env);
  }

  updateSession(id: string, patch: Partial<Session>): void {
    const s = this.session(id);
    if (!s) return;
    this.emitDomain({
      type: "session.updated",
      sessionId: null,
      payload: { session: { ...s, ...patch, updatedAt: new Date().toISOString() } },
    });
  }

  sessionSnapshot(sessionId: string): SessionSnapshot {
    const session = this.session(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const t = this.transcript(sessionId);
    const now = new Date().toISOString();
    const items: ItemRecord[] = [];
    let position = 0;
    for (const thread of Object.values(t.threads)) {
      for (const id of thread.itemIds) {
        const entry = t.items[id];
        if (!entry) continue;
        items.push({
          sessionId,
          threadId: thread.id,
          turnId: entry.turnId,
          position: position++,
          item: entry.item,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return {
      seq: this.seq,
      session: { ...session, rootThreadId: t.rootThreadId ?? session.rootThreadId },
      threads: Object.values(t.threads).map((th) => ({
        id: th.id,
        sessionId,
        parentThreadId: th.parentThreadId,
        parentItemId: th.parentItemId,
        title: th.title,
        agentType: th.agentType,
        createdAt: session.createdAt,
      })),
      turns: Object.values(t.turns).map((turn) => ({ ...turn, sessionId })),
      items,
    };
  }
}
