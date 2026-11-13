import {
  appendToolOutput,
  type InboxItem,
  type Item,
  type ItemDelta,
  type ItemOf,
  type ItemRecord,
  type JsonValue,
  type Session,
  STREAMED_OUTPUT_CHARS,
} from "@codeden/contracts";
import { isFactorySession } from "../../services/factory/starter";

export type RequestItem = ItemOf<"approval_request"> | ItemOf<"user_question">;

/** Approval requests and user questions: the items that wait on a person. */
export function isRequestItem(item: Item): item is RequestItem {
  return item.kind === "approval_request" || item.kind === "user_question";
}

/** A request still waiting on a response. */
export function isOpenRequest(item: Item): item is RequestItem {
  return isRequestItem(item) && item.status === "in_progress";
}

/** Apply an incremental delta to an item (pure). Unknown combinations leave the item unchanged. */
export function applyDelta(item: Item, delta: ItemDelta): Item {
  switch (delta.type) {
    case "text":
      if (item.kind === "assistant_message" || item.kind === "reasoning" || item.kind === "plan") {
        return { ...item, text: item.text + delta.text };
      }
      return item;
    case "reasoning_summary":
      return item.kind === "reasoning"
        ? { ...item, summary: (item.summary ?? "") + delta.text }
        : item;
    case "tool_output":
      if (item.kind !== "tool_call") return item;
      return { ...item, output: appendToolOutput(item.output, delta.text, STREAMED_OUTPUT_CHARS) };
    case "tool_input":
      return item;
  }
}

/** Deterministic inbox id for the request item `itemId`, so log replay is idempotent. */
export function requestInboxId(sessionId: string, itemId: string): string {
  return `inbox:${sessionId}:${itemId}`;
}

/** Inbox item mirroring an approval request or question (§11.1). */
export function inboxForRequest(
  session: Session,
  record: ItemRecord & { item: RequestItem },
  ts: string,
): InboxItem {
  const { item } = record;
  const isApproval = item.kind === "approval_request";
  return {
    id: requestInboxId(session.id, item.id),
    kind: isApproval ? "approval" : "question",
    status: "open",
    priority: isApproval ? "high" : "normal",
    notify: "needs_you",
    title: isApproval ? item.title : (item.questions[0]?.question ?? "Question"),
    body: isApproval ? requestBody(item) : questionBody(item),
    projectId: session.projectId,
    sessionId: session.id,
    threadId: record.threadId,
    itemId: item.id,
    requestId: item.requestId,
    issue: session.issue,
    pr: session.pr,
    automationRunId: session.automationRunId,
    createdAt: ts,
    updatedAt: ts,
    resolvedAt: null,
    resolution: null,
  };
}

function requestBody(item: ItemOf<"approval_request">): string | null {
  const parts = [
    item.reason,
    item.command ? `$ ${item.command}` : undefined,
    item.paths?.join("\n"),
  ];
  const body = parts.filter(Boolean).join("\n\n");
  return body || null;
}

function questionBody(item: ItemOf<"user_question">): string | null {
  if (item.questions.length < 2) return null;
  return item.questions.map((q) => `- ${q.question}`).join("\n");
}

/** How a finished request was answered, stored on the inbox item. */
export function requestResolution(item: RequestItem): JsonValue {
  if (item.kind === "approval_request") {
    return {
      status: item.status,
      ...(item.decision ? { decision: item.decision } : {}),
      ...(item.decidedBy ? { decidedBy: item.decidedBy } : {}),
    };
  }
  return {
    status: item.status,
    ...(item.answers ? { answers: item.answers } : {}),
    ...(item.decidedBy ? { decidedBy: item.decidedBy } : {}),
  };
}

/** Close an open inbox item; `completed`/`declined` resolve it, anything else dismisses it. */
export function closeInbox(
  inbox: InboxItem,
  status: InboxItem["status"],
  resolution: JsonValue,
  ts: string,
): InboxItem {
  return { ...inbox, status, resolution, resolvedAt: ts, updatedAt: ts };
}

/**
 * Inbox item for a failed run (§11.1 "failed or stuck runs"). A factory session's failure is the
 * factory's to handle (it fails or retries the item and pauses the loop when too many fail), so
 * it notifies as factory activity; any other session's failure needs the user.
 */
export function runFailedInbox(
  session: Session,
  id: string,
  message: string,
  threadId: string | null,
  ts: string,
): InboxItem {
  return {
    id,
    kind: "run_failed",
    status: "open",
    priority: "normal",
    notify: isFactorySession(session) ? "factory" : "failure",
    title: `Run failed: ${session.title ?? session.purpose}`,
    body: message,
    projectId: session.projectId,
    sessionId: session.id,
    threadId,
    itemId: null,
    requestId: null,
    issue: session.issue,
    pr: session.pr,
    automationRunId: session.automationRunId,
    createdAt: ts,
    updatedAt: ts,
    resolvedAt: null,
    resolution: null,
  };
}

/** The follow-ups item of the latest turn among `records` (ordered by position), if any. */
export function latestFollowups(records: ItemRecord[]): ItemOf<"followups"> | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const item = records[i]?.item;
    if (item?.kind === "followups") return item;
  }
  return null;
}
