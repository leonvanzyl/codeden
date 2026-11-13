import {
  type AgentEvent,
  appendToolOutput,
  type ErrorInfo,
  type Item,
  type ItemDelta,
  OUTPUT_PREVIEW_CHARS,
  type SessionSnapshot,
  type TurnStatus,
  type Usage,
} from "@codeden/contracts";

export interface TurnState {
  id: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt: string | null;
  error: ErrorInfo | null;
  /** Set when the conversation can be forked through this turn ("Fork from here", §9). */
  forkPoint?: string | null;
}

export interface ThreadState {
  id: string;
  parentThreadId: string | null;
  parentItemId: string | null;
  title: string | null;
  agentType: string | null;
  /** Item ids in display order. */
  itemIds: string[];
  /** Turn ids in order. */
  turnIds: string[];
}

export interface ItemEntry {
  item: Item;
  turnId: string;
  threadId: string;
  /** Order within the thread, when known from the server projection. */
  position?: number;
}

/** Client-side transcript of one session, built from a snapshot plus live agent events. */
export interface TranscriptState {
  sessionId: string;
  /** Highest event seq applied. */
  seq: number;
  rootThreadId: string | null;
  threads: Record<string, ThreadState>;
  turns: Record<string, TurnState>;
  items: Record<string, ItemEntry>;
  usage: Usage | null;
  title: string | null;
  model: string | null;
}

export function emptyTranscript(sessionId: string): TranscriptState {
  return {
    sessionId,
    seq: 0,
    rootThreadId: null,
    threads: {},
    turns: {},
    items: {},
    usage: null,
    title: null,
    model: null,
  };
}

/** Build transcript state from `GET /api/sessions/:id/snapshot`. */
export function transcriptFromSnapshot(snap: SessionSnapshot): TranscriptState {
  const state = emptyTranscript(snap.session.id);
  state.seq = snap.seq;
  state.rootThreadId = snap.session.rootThreadId;
  state.title = snap.session.title;
  state.model = snap.session.model;
  for (const t of snap.threads) {
    state.threads[t.id] = {
      id: t.id,
      parentThreadId: t.parentThreadId,
      parentItemId: t.parentItemId,
      title: t.title,
      agentType: t.agentType,
      itemIds: [],
      turnIds: [],
    };
  }
  for (const turn of snap.turns) {
    state.turns[turn.id] = { ...turn };
    ensureThread(state, turn.threadId).turnIds.push(turn.id);
  }
  const records = [...snap.items].sort((a, b) => a.position - b.position);
  for (const r of records) {
    state.items[r.item.id] = {
      item: r.item,
      turnId: r.turnId,
      threadId: r.threadId,
      position: r.position,
    };
    ensureThread(state, r.threadId).itemIds.push(r.item.id);
  }
  if (!state.rootThreadId) {
    state.rootThreadId = Object.values(state.threads).find((t) => !t.parentThreadId)?.id ?? null;
  }
  return state;
}

function ensureThread(state: TranscriptState, id: string): ThreadState {
  let thread = state.threads[id];
  if (!thread) {
    thread = {
      id,
      parentThreadId: null,
      parentItemId: null,
      title: null,
      agentType: null,
      itemIds: [],
      turnIds: [],
    };
    state.threads[id] = thread;
  }
  return thread;
}

function applyDelta(item: Item, delta: ItemDelta): Item {
  switch (delta.type) {
    case "text":
      if (item.kind === "assistant_message" || item.kind === "reasoning" || item.kind === "plan") {
        return { ...item, text: item.text + delta.text };
      }
      return item;
    case "reasoning_summary":
      if (item.kind === "reasoning") return { ...item, summary: (item.summary ?? "") + delta.text };
      return item;
    case "tool_output":
      // Live output keeps the same bounded tail the server previews, so a long command never
      // grows the tab; the rest is fetched on demand ("Show full output").
      if (item.kind === "tool_call") {
        return { ...item, output: appendToolOutput(item.output, delta.text, OUTPUT_PREVIEW_CHARS) };
      }
      return item;
    case "tool_input":
      return item;
  }
}

/**
 * Apply one normalized agent event. Returns a new state object (shallow-copied where it
 * changed) so React selectors re-render; never mutates `prev`.
 */
export function applyAgentEvent(
  prev: TranscriptState,
  event: AgentEvent,
  meta: { seq?: number; ts?: string } = {},
): TranscriptState {
  const state: TranscriptState = {
    ...prev,
    threads: { ...prev.threads },
    turns: { ...prev.turns },
    items: { ...prev.items },
  };
  if (meta.seq !== undefined) state.seq = Math.max(prev.seq, meta.seq);
  const ts = meta.ts ?? new Date().toISOString();

  const touchThread = (id: string): ThreadState => {
    const existing = state.threads[id];
    const copy: ThreadState = existing
      ? { ...existing, itemIds: [...existing.itemIds], turnIds: [...existing.turnIds] }
      : {
          id,
          parentThreadId: null,
          parentItemId: null,
          title: null,
          agentType: null,
          itemIds: [],
          turnIds: [],
        };
    state.threads[id] = copy;
    return copy;
  };

  const upsertItem = (threadId: string, turnId: string, item: Item) => {
    const existing = state.items[item.id];
    state.items[item.id] = { item, threadId, turnId };
    if (!existing) touchThread(threadId).itemIds.push(item.id);
  };

  switch (event.type) {
    case "session.updated":
      if (event.title !== undefined) state.title = event.title;
      if (event.model !== undefined) state.model = event.model;
      break;
    case "thread.started": {
      const t = touchThread(event.thread.id);
      t.parentThreadId = event.thread.parentThreadId ?? null;
      t.parentItemId = event.thread.parentItemId ?? null;
      t.title = event.thread.title ?? null;
      t.agentType = event.thread.agentType ?? null;
      if (!t.parentThreadId && !state.rootThreadId) state.rootThreadId = t.id;
      break;
    }
    case "turn.started": {
      const t = touchThread(event.threadId);
      if (!t.turnIds.includes(event.turnId)) t.turnIds.push(event.turnId);
      state.turns[event.turnId] = {
        id: event.turnId,
        threadId: event.threadId,
        status: "running",
        startedAt: ts,
        completedAt: null,
        error: null,
      };
      if (!state.rootThreadId) state.rootThreadId = event.threadId;
      break;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted": {
      const turn = state.turns[event.turnId];
      const status: TurnStatus =
        event.type === "turn.completed"
          ? "completed"
          : event.type === "turn.failed"
            ? "failed"
            : "interrupted";
      state.turns[event.turnId] = {
        id: event.turnId,
        threadId: event.threadId,
        startedAt: turn?.startedAt ?? ts,
        status,
        completedAt: ts,
        error: event.type === "turn.failed" ? event.error : (turn?.error ?? null),
        forkPoint: event.forkPoint ?? null,
      };
      break;
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      upsertItem(event.threadId, event.turnId, event.item);
      break;
    case "item.delta": {
      const entry = state.items[event.itemId];
      if (entry)
        state.items[event.itemId] = { ...entry, item: applyDelta(entry.item, event.delta) };
      break;
    }
    case "usage.updated":
      state.usage = { ...(state.usage ?? {}), ...event.usage };
      break;
  }
  return state;
}

/** Items of a thread in order. */
export function threadItems(state: TranscriptState, threadId: string): ItemEntry[] {
  const thread = state.threads[threadId];
  if (!thread) return [];
  return thread.itemIds.flatMap((id) => {
    const entry = state.items[id];
    return entry ? [entry] : [];
  });
}

/** The running turn of a thread, if any. */
export function activeTurn(state: TranscriptState, threadId: string): TurnState | null {
  const thread = state.threads[threadId];
  if (!thread) return null;
  for (let i = thread.turnIds.length - 1; i >= 0; i--) {
    const turn = state.turns[thread.turnIds[i] ?? ""];
    if (turn?.status === "running") return turn;
  }
  return null;
}
