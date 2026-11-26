import { INBOX_ACT_NOTIFY, type InboxItem } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";

/**
 * What a project's PM may resolve as stale (#673): triage decisions, and messages that only
 * inform. A message a person has to act on (`notify` needs_you or failure: a sign-in, the notice
 * that the PM changed an automation) stays with the user, as do approvals, questions (the PM
 * answers its own work's with `answer_question`; the user's sessions' questions and MCP servers'
 * forms are the user's) and every other kind.
 */
export function pmMayResolve(item: Pick<InboxItem, "kind" | "notify">): boolean {
  if (item.kind === "triage") return true;
  return item.kind === "message" && !INBOX_ACT_NOTIFY.includes(item.notify);
}

/** Why the PM may not resolve `item`. */
function refusal(item: InboxItem): string {
  if (item.kind === "approval") return "Approvals stay with the user.";
  if (item.kind === "question") {
    return "Questions stay with the user; answer your own agents' questions with answer_question.";
  }
  if (item.kind === "message") return "This message asks the user to act, so it stays with them.";
  return `Only triage decisions and informational messages can be resolved here (this item is a ${item.kind}).`;
}

/** `list_inbox_items` (#673): every open inbox item of the PM's project, not just the digest's. */
export const listInboxItems = defineTool({
  name: "list_inbox_items",
  description:
    "Every open inbox item of this project (the status digest names only the first few): id, kind, title, linked issue and PR numbers, session, when it was raised, and whether you may resolve it with resolve_inbox_item. Use it to find stale items, such as a triage decision whose issue is already closed.",
  roles: ["pm"],
  scope: "project",
  input: z.object({}),
  handler: async (_input, { services, projectId }) => {
    const items = services.inbox.list({ projectId });
    return {
      open: items.length,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        issue: i.issue?.number ?? null,
        pr: i.pr?.number ?? null,
        sessionId: i.sessionId,
        createdAt: i.createdAt,
        youMayResolve: pmMayResolve(i),
      })),
    };
  },
});

/**
 * `resolve_inbox_item` (#673): the PM closes a stale triage decision or informational message of
 * its project, with its reason. Recorded as the PM's (`InboxSettlement` by `pm`), kept in the
 * inbox's history, and the user can restore it.
 */
export const resolveInboxItem = defineTool({
  name: "resolve_inbox_item",
  description:
    "Resolve a stale inbox item of this project with a one-line reason: a triage decision whose issue was closed or is already being worked on, or an informational message that no longer applies. Only triage decisions and informational messages; approvals, questions and messages that ask the user to act stay with the user. The item stays in the inbox history as resolved by you, and the user can restore it.",
  roles: ["pm"],
  scope: "project",
  input: z.object({
    inboxItemId: z.string().min(1),
    reason: z.string().min(1).max(500).describe("Why it no longer needs the user, in one line"),
  }),
  handler: async ({ inboxItemId, reason }, { services, projectId }) => {
    const item = services.inbox.find(inboxItemId);
    if (!item || item.projectId !== projectId) {
      throw new ToolError(`No inbox item ${inboxItemId} in this project`);
    }
    if (item.status !== "open") throw new ToolError(`That item was already ${item.status}`);
    if (!pmMayResolve(item)) throw new ToolError(refusal(item));
    services.inbox.settle(item, { by: "pm", note: reason });
    return `Resolved "${item.title}". It stays in the inbox history, where the user can restore it.`;
  },
});
