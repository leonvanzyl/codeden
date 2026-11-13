import type {
  AgentEvent,
  AgentEventOf,
  ErrorInfo,
  Item,
  ItemRecord,
  Session,
  SessionStatus,
} from "@codeden/contracts";
import { Draft } from "./draft";
import {
  applyDelta,
  closeInbox,
  inboxForRequest,
  isOpenRequest,
  isRequestItem,
  type RequestItem,
  requestInboxId,
  requestResolution,
  runFailedInbox,
} from "./items";
import { awaitsRetryDecision } from "./retry";
import type { Mutation, ProjectionReader } from "./types";
import { accumulateUsage, hasTokenCounts, mergeLatestUsage } from "./usage";

/** Statuses that agent events never move a session out of. */
const TERMINAL: ReadonlySet<SessionStatus> = new Set(["completed", "stopped"]);

/**
 * The projection reducer (§6): given current projections and one normalized agent event,
 * return the changes to apply. Pure: reads go through `reader`, nothing is written.
 */
export function reduceAgentEvent(
  reader: ProjectionReader,
  sessionId: string,
  event: AgentEvent,
  ts: string,
): Mutation[] {
  const d = new Draft(reader);
  switch (event.type) {
    case "session.updated":
      updateSession(d, sessionId, ts, (s) => ({
        ...s,
        ...(event.resumeToken !== undefined ? { resumeToken: event.resumeToken } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        // The agent left (or entered) plan mode itself, e.g. once its plan was approved.
        ...(event.planMode !== undefined ? { planMode: event.planMode } : {}),
      }));
      break;
    case "thread.started":
      onThreadStarted(d, sessionId, event, ts);
      break;
    case "turn.started":
      d.putTurn({
        ...(d.getTurn(sessionId, event.turnId) ?? { usage: null, error: null }),
        id: event.turnId,
        threadId: event.threadId,
        sessionId,
        status: "running",
        startedAt: d.getTurn(sessionId, event.turnId)?.startedAt ?? ts,
        completedAt: null,
        forkPoint: null,
      });
      if (isRootThread(d, sessionId, event.threadId)) setStatus(d, sessionId, "running", ts);
      break;
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
      onTurnEnded(d, sessionId, event, ts);
      break;
    case "item.started":
    case "item.updated":
    case "item.completed":
      putItem(d, sessionId, event.threadId, event.turnId, event.item, ts);
      break;
    case "item.delta": {
      const record = d.getItem(sessionId, event.itemId);
      if (!record) break;
      const next = applyDelta(record.item, event.delta);
      if (next !== record.item) d.putItem({ ...record, item: next, updatedAt: ts });
      break;
    }
    case "usage.updated":
      onUsage(d, sessionId, event);
      break;
  }
  return d.mutations();
}

function onThreadStarted(
  d: Draft,
  sessionId: string,
  event: AgentEventOf<"thread.started">,
  ts: string,
): void {
  const { thread } = event;
  const existing = d.getThread(sessionId, thread.id);
  d.putThread({
    id: thread.id,
    sessionId,
    parentThreadId: thread.parentThreadId ?? null,
    parentItemId: thread.parentItemId ?? null,
    title: thread.title ?? existing?.title ?? null,
    agentType: thread.agentType ?? existing?.agentType ?? null,
    createdAt: existing?.createdAt ?? ts,
  });
  if (!thread.parentThreadId) {
    updateSession(d, sessionId, ts, (s) =>
      s.rootThreadId === thread.id ? s : { ...s, rootThreadId: thread.id },
    );
  }
}

function onTurnEnded(
  d: Draft,
  sessionId: string,
  event: AgentEventOf<"turn.completed" | "turn.failed" | "turn.interrupted">,
  ts: string,
): void {
  const status =
    event.type === "turn.completed"
      ? "completed"
      : event.type === "turn.failed"
        ? "failed"
        : "interrupted";
  const error: ErrorInfo | null = event.type === "turn.failed" ? event.error : null;
  const turn = d.getTurn(sessionId, event.turnId);
  d.putTurn({
    usage: null,
    startedAt: ts,
    ...turn,
    id: event.turnId,
    threadId: event.threadId,
    sessionId,
    status,
    completedAt: ts,
    error,
    // Where the conversation can be forked through this turn ("Fork from here", §9).
    forkPoint: event.forkPoint ?? null,
  });

  // Requests left open by the turn can no longer be answered.
  for (const record of d.openRequestItems(sessionId)) {
    if (record.turnId !== event.turnId || !isRequestItem(record.item)) continue;
    // CodeDen `ask_user` questions outlive the turn; late answers arrive as messages.
    if (record.item.kind === "user_question" && record.item.deferred) continue;
    putItem(d, sessionId, record.threadId, record.turnId, cancelRequest(record.item), ts);
  }

  if (!isRootThread(d, sessionId, event.threadId)) return;
  if (event.type === "turn.completed") {
    setStatus(d, sessionId, "idle", ts);
  } else if (event.type === "turn.interrupted") {
    setStatus(d, sessionId, event.reason === "runner_restart" ? "interrupted" : "idle", ts);
  } else {
    const current = d.getSession(sessionId)?.session;
    if (current && awaitsRetryDecision(current, event.error)) {
      setStatus(d, sessionId, "idle", ts);
      return;
    }
    setStatus(d, sessionId, "failed", ts);
    const session = d.getSession(sessionId)?.session;
    if (session) {
      const id = `inbox:${sessionId}:${event.turnId}:failed`;
      if (!d.getInbox(id)) {
        d.putInbox(runFailedInbox(session, id, event.error.message, event.threadId, ts));
      }
    }
  }
}

function cancelRequest(item: RequestItem): Item {
  return { ...item, status: "cancelled" };
}

function putItem(
  d: Draft,
  sessionId: string,
  threadId: string,
  turnId: string,
  item: Item,
  ts: string,
): void {
  const existing = d.getItem(sessionId, item.id);
  const record: ItemRecord = existing
    ? { ...existing, item, updatedAt: ts }
    : {
        sessionId,
        threadId,
        turnId,
        position: d.nextItemPosition(sessionId, threadId),
        item,
        createdAt: ts,
        updatedAt: ts,
      };
  d.putItem(record);
  if (isRequestItem(item)) syncRequest(d, { ...record, item }, ts);
}

/** Mirror a request item into the inbox and the session's `waiting` status. */
function syncRequest(d: Draft, record: ItemRecord & { item: RequestItem }, ts: string): void {
  const sessionRecord = d.getSession(record.sessionId);
  if (!sessionRecord) return;
  const { session } = sessionRecord;
  const { item } = record;
  const inboxId = requestInboxId(session.id, item.id);
  const existing = d.getInbox(inboxId);

  // A deferred `ask_user` question can outlive its turn: it only blocks a running turn.
  const turnRunning = d.getTurn(session.id, record.turnId)?.status === "running";
  if (item.status === "in_progress") {
    if (!existing) d.putInbox(inboxForRequest(session, record, ts));
    if (turnRunning || !(item.kind === "user_question" && item.deferred)) {
      setStatus(d, session.id, "waiting", ts);
    }
    return;
  }

  if (existing?.status === "open") {
    const status =
      item.status === "completed" || item.status === "declined" ? "resolved" : "dismissed";
    d.putInbox(closeInbox(existing, status, requestResolution(item), ts));
  }
  const current = d.getSession(session.id)?.session;
  if (current?.status === "waiting" && d.openRequestItems(session.id).length === 0) {
    setStatus(d, session.id, turnRunning ? "running" : "idle", ts);
  }
}

function onUsage(d: Draft, sessionId: string, event: AgentEventOf<"usage.updated">): void {
  const sessionRecord = d.getSession(sessionId);
  if (!sessionRecord) return;
  // Reports without token counts (rate limits, context size) never replace a turn's usage.
  if (!event.turnId || !hasTokenCounts(event.usage)) {
    d.putSession(sessionRecord.session, mergeLatestUsage(sessionRecord.usage, event.usage), false);
    return;
  }
  const turn = d.getTurn(sessionId, event.turnId);
  const total = accumulateUsage(sessionRecord.usage, turn?.usage ?? null, event.usage);
  if (turn) d.putTurn({ ...turn, usage: event.usage });
  d.putSession(sessionRecord.session, total, false);
}

/** True when `threadId` is (or will become) the session's root thread. */
function isRootThread(d: Draft, sessionId: string, threadId: string): boolean {
  const session = d.getSession(sessionId)?.session;
  if (!session) return false;
  if (session.rootThreadId) return session.rootThreadId === threadId;
  const thread = d.getThread(sessionId, threadId);
  return !thread || thread.parentThreadId === null;
}

function setStatus(d: Draft, sessionId: string, status: SessionStatus, ts: string): void {
  updateSession(d, sessionId, ts, (s) => {
    if (s.status === status || TERMINAL.has(s.status)) return s;
    // A pending request keeps the session waiting even if a subagent turn starts.
    if (status === "running" && s.status === "waiting" && hasOpenRequests(d, sessionId)) return s;
    return { ...s, status };
  });
}

function hasOpenRequests(d: Draft, sessionId: string): boolean {
  return d.openRequestItems(sessionId).some((r) => isOpenRequest(r.item));
}

function updateSession(
  d: Draft,
  sessionId: string,
  ts: string,
  change: (s: Session) => Session,
): void {
  const record = d.getSession(sessionId);
  if (!record) return;
  const next = change(record.session);
  if (next === record.session) return;
  d.putSession({ ...next, updatedAt: ts }, record.usage);
}
