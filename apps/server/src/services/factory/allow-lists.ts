import {
  AGENT_ALLOW_LIST_NOTICE,
  type Item,
  type ItemOf,
  type RawEventEnvelope,
} from "@codeden/contracts";
import { type FactoryContext, raiseInbox } from "./context";
import { isFactorySession } from "./sessions";

/** Prefix of the inbox items for factory work that runs with the agent's own allow-list. */
export const ALLOW_LIST_INBOX_PREFIX = "inbox:factory-allow-list:";

/** The warning a session gives when its worktree holds the agent's own allow-list, if `e` is one. */
function allowListNotice(e: RawEventEnvelope): ItemOf<"notice"> | undefined {
  if (e.type !== "agent.item.completed" || !e.sessionId) return undefined;
  const item = (e.payload as { item?: Item }).item;
  return item?.kind === "notice" && item.code === AGENT_ALLOW_LIST_NOTICE ? item : undefined;
}

/** True when `e` is a session's allow-list warning (`flagAllowList` then acts on it). */
export const isAllowListNotice = (e: RawEventEnvelope): boolean => !!allowListNotice(e);

/**
 * A factory session started in a worktree holding the agent's own allow-list (§11.2): Cursor or
 * Gemini CLI then runs what it lists without asking, so CodeDen's approvals never see it. The
 * session's warning goes on the item (its note) and in the inbox, as nobody may be watching the
 * transcript. Returns true when it was put there.
 */
export function flagAllowList(ctx: FactoryContext, e: RawEventEnvelope): boolean {
  const notice = allowListNotice(e);
  if (!notice || !e.sessionId) return false;
  const session = ctx.repo.find(e.sessionId)?.session;
  if (!session?.projectId || !isFactorySession(session)) return false;
  const work = ctx.store.itemForSession(session.projectId, session.id);
  if (!work) return false;
  ctx.store.updateItem(work.id, (i) => ({ ...i, note: notice.message }), { touch: false });
  raiseInbox(ctx, {
    id: `${ALLOW_LIST_INBOX_PREFIX}${work.id}`,
    kind: "message",
    notify: "needs_you",
    priority: "high",
    projectId: session.projectId,
    sessionId: session.id,
    title: `Factory: "${work.title}" runs with the agent's own allow-list`,
    body: notice.message,
    issue: work.issue,
    pr: work.pr,
  });
  return true;
}
