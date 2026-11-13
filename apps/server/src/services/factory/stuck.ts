import type { FactoryItem } from "@codeden/contracts";
import { type FactoryContext, factoryNotice, raiseInbox } from "./context";
import { DECISION_INBOX_PREFIX } from "./unattended";

/**
 * Truly stuck (§10.1): the few things the loop can't settle by itself reach the PM and the
 * inbox. They are an item that already used its rebuild, a protected area, and CI that can
 * never run on the repository. Everything else (conflicts, behind PRs, infrastructure
 * failures) the loop handles on its own. In a dark factory nobody is watching, so each one is a
 * recorded decision flagged for the user, listed in the daily digest: never a PR silently
 * waiting.
 */

/** Inbox id of a stuck item (software factory; one per item). */
export const stuckInboxId = (itemId: string) => `inbox:factory-stuck:${itemId}`;

/** Inbox id of a stuck item's recorded decision (dark factory; one per item). */
export const stuckDecisionId = (itemId: string) => `${DECISION_INBOX_PREFIX}stuck:${itemId}`;

export function isDarkFactory(ctx: FactoryContext, projectId: string): boolean {
  return ctx.projects.get(projectId).autonomyMode === "dark_factory";
}

/** Record a stuck item as a decision flagged for the user (dark factory; the digest lists it). */
export function recordStuckDecision(
  ctx: FactoryContext,
  item: FactoryItem,
  d: { question: string; decision: string; why: string },
): void {
  raiseInbox(ctx, {
    id: stuckDecisionId(item.id),
    kind: "message",
    notify: "needs_you",
    priority: "high",
    projectId: item.projectId,
    sessionId: item.builderSessionId,
    issue: item.issue,
    pr: item.pr ?? item.rebuiltFrom,
    title: `Factory needs you: ${d.question}`,
    body: [
      `**Question:** ${d.question}`,
      "",
      `**Decision:** ${d.decision}`,
      "",
      `**Why:** ${d.why}`,
      "",
      "The factory carried on with everything that doesn't depend on this.",
    ].join("\n"),
  });
}

/**
 * Tell the user and the PM that an item is stuck: an inbox item that needs them (a recorded
 * decision, in a dark factory) and a notice that wakes the PM. The caller marks the item.
 */
export function raiseStuck(
  ctx: FactoryContext,
  item: FactoryItem,
  reason: string,
  /** What a person can do about it. */
  action: string,
): void {
  const pr = item.pr ?? item.rebuiltFrom;
  const what = `"${item.title}"${pr ? ` (#${pr.number})` : ""}`;
  if (isDarkFactory(ctx, item.projectId)) {
    recordStuckDecision(ctx, item, {
      question: `What to do with ${what}?`,
      decision: `Left for you: ${action}`,
      why: reason,
    });
  } else {
    raiseInbox(ctx, {
      id: stuckInboxId(item.id),
      kind: pr ? "pr_review" : "run_failed",
      notify: "needs_you",
      priority: "high",
      projectId: item.projectId,
      sessionId: item.builderSessionId,
      issue: item.issue,
      pr,
      title: `Factory item stuck: ${item.title}`,
      body: `${reason}. ${action}`,
    });
  }
  factoryNotice(ctx, {
    id: `factory.stuck:${item.id}`,
    projectId: item.projectId,
    target: "pm",
    event: "failed",
    title: `Stuck, needs the user: ${item.title}`,
    text: `${reason}. ${action}`,
    itemIds: [item.id],
  });
}
