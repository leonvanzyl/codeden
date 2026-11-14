import type { FactoryItem, GithubIssue, Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { closeInboxFor } from "./merge";
import { rebuildOriginal } from "./rebuild";

/**
 * Closed issues settle their failed items (§10.1, "Needs you"). An item that failed without a
 * pull request has nothing left for a person to decide once its issue is closed on GitHub (a
 * duplicate, resolved by another pull request, not planned): it finishes by itself, with the
 * reason recorded. When a merged pull request closed the issue, the work is done (`merged`,
 * naming that PR); otherwise it is `rejected`.
 *
 * An item with a pull request of its own, or a rebuild's original it still stands for, is left
 * to ownership (`owned.ts`): a person merging or closing that PR finishes it (`prDecidedOutside`,
 * with the merge recorded), and while it is open it waits for them. Its "Fixes #n" closes the
 * issue in the same sync as the merge, so settling it here would pre-empt that.
 */

const CLOSED_AS: Record<NonNullable<GithubIssue["stateReason"]>, string> = {
  completed: " as completed",
  not_planned: " as not planned",
  duplicate: " as a duplicate",
};

/** Settle the project's failed items whose issue was closed; returns how many it settled. */
export function settleClosedIssues(ctx: FactoryContext, project: Project): number {
  let settled = 0;
  for (const item of ctx.store.items(project.id, ["failed"])) {
    if (!item.issue || item.pr || rebuildOriginal(item)) continue;
    const issue = ctx.github.issue(project.id, item.issue.number);
    if (issue?.state !== "closed") continue;
    settle(ctx, project, item, issue);
    settled++;
  }
  return settled;
}

function settle(ctx: FactoryContext, project: Project, item: FactoryItem, issue: GithubIssue) {
  const at = ctx.now().toISOString();
  const closedAs = issue.stateReason ? CLOSED_AS[issue.stateReason] : "";
  // A duplicate or a "not planned" was resolved by nothing, whatever links to it.
  const resolvedBy =
    issue.stateReason === "completed" || !issue.stateReason
      ? ctx.github.mergedPrClosing(project.id, issue.number)
      : null;
  const reason = resolvedBy
    ? `The issue was closed on GitHub: resolved by #${resolvedBy.number}`
    : `The issue was closed on GitHub${closedAs}`;
  // The resolving PR isn't the item's own (`pr` stays as it was): it is named in the reason.
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: resolvedBy ? "merged" : "rejected",
    reason,
    failureKind: null,
    note: resolvedBy ? `Resolved by #${resolvedBy.number}` : null,
    finishedAt: i.finishedAt ?? at,
  }));
  closeInboxFor(ctx, item.id, "issue closed");
  ctx.log?.(`factory: ${item.id}: settled, ${reason}`);
}
