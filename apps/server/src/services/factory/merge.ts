import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, factoryNotice, raiseInbox } from "./context";
import type { FactoryPr } from "./github-port";

/**
 * The Merge step (§10.1): every check passed. With auto-merge on and trusted work, the factory
 * squash-merges and watches the default branch; otherwise the pull request is the user's to
 * merge on GitHub ("ready for you"). Also what happens when a person merges or closes it.
 */

/** Inbox id of "ready for you to merge". */
export const readyInboxId = (itemId: string) => `inbox:factory-ready:${itemId}`;

/** The PR was merged or closed by someone (a person, on GitHub). */
export function prDecidedOutside(
  ctx: FactoryContext,
  item: FactoryItem,
  ref: NonNullable<FactoryItem["pr"]>,
): void {
  const at = ctx.now().toISOString();
  const merged = ref.state === "merged";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    pr: ref,
    stage: merged ? "merged" : "rejected",
    reason: merged ? null : "The pull request was closed on GitHub",
    note: merged ? "Merged on GitHub" : null,
    mergedAt: merged ? (i.mergedAt ?? at) : i.mergedAt,
    finishedAt: at,
  }));
  const ready = ctx.inbox.find(readyInboxId(item.id));
  if (ready?.status === "open") {
    ctx.inbox.close(ready, "resolved", { note: merged ? "merged" : "closed" });
  }
}

/** Every check passed and the factory doesn't merge this one: it's the user's to merge. */
export async function readyForYou(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<void> {
  const why =
    item.trust === "admitted"
      ? "it came from an untrusted author, so a person merges it"
      : "auto-merge is off";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: `Ready to merge: every check passed (${why})`,
  }));
  if (item.nudges.ready) return;
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, ready: at } }));
  const passed = item.checks
    .filter((c) => c.state === "pass")
    .map((c) => c.name)
    .join(", ");
  raiseInbox(ctx, {
    id: readyInboxId(item.id),
    kind: "pr_review",
    // The factory won't merge this one: a person has to.
    notify: "needs_you",
    priority: "normal",
    projectId: project.id,
    sessionId: item.builderSessionId,
    issue: item.issue,
    pr: item.pr,
    title: `Ready to merge: ${item.title}`,
    body: `Every factory check passed (${passed}); ${why}. Review the evidence on the pull request and merge it on GitHub.`,
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `Every CodeDen software factory check passed (${passed}). Ready for a maintainer to review and merge.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.ready:${item.id}`,
    projectId: project.id,
    target: "pm",
    event: "ready",
    title: `Ready for the user to merge #${item.pr?.number ?? "?"}: ${item.title}`,
    text: `Every check passed; ${why}.`,
    itemIds: [item.id],
    wake: false,
  });
}

export async function autoMerge(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  current: FactoryItem,
  pr: FactoryPr,
  checks: FactoryItem["checks"],
): Promise<FactoryLoop> {
  const title = `${current.title} (#${pr.ref.number})`;
  const res = await ctx.github
    .merge(project.id, pr.ref.number, { sha: pr.headSha, title })
    .catch((error: unknown) => ({ merged: false, sha: null, error: errorMessage(error) }));
  if (!res.merged) {
    const why = "error" in res ? res.error : "GitHub did not merge it";
    ctx.store.updateItem(current.id, (i) => ({ ...i, note: `Merge failed: ${why}` }));
    return loop;
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(current.id, (i) => ({
    ...i,
    stage: "watching",
    pr: { ...pr.ref, state: "merged" },
    mergeSha: res.sha,
    mergedAt: at,
    note: "Merged; watching CI on the default branch",
  }));
  const ready = ctx.inbox.find(readyInboxId(current.id));
  if (ready?.status === "open") ctx.inbox.close(ready, "resolved", { note: "merged" });
  if (current.issue && current.source !== "revert") {
    const passed = checks
      .filter((c) => c.state === "pass")
      .map((c) => c.name)
      .join(", ");
    await ctx.github
      .comment(
        project.id,
        current.issue.number,
        `Merged automatically by the CodeDen factory in #${pr.ref.number} after every merge check passed (${passed}).`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.merged:${current.id}`,
    projectId: project.id,
    target: "pm",
    event: "merged",
    title: `Factory merged #${pr.ref.number}: ${current.title}`,
    text: `Merged ${pr.ref.url} (${res.sha ?? "unknown sha"}); watching CI on the default branch.`,
    itemIds: [current.id],
    wake: false,
  });
  return { ...loop, mergesToday: loop.mergesToday + 1, consecutiveFailures: 0 };
}

/**
 * Escalated items (a protected area) wait for a person; once they merge or close the PR on
 * GitHub, the item is done. Reads the synced PR, no API call.
 */
export function advanceEscalated(ctx: FactoryContext, project: Project, item: FactoryItem): void {
  if (!item.pr) return;
  const ref = ctx.github.prRef(project.id, item.pr.number);
  if (ref && (ref.state === "merged" || ref.state === "closed")) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      pr: ref,
      stage: ref.state === "merged" ? "merged" : "rejected",
      reason: ref.state === "merged" ? i.reason : "The pull request was closed on GitHub",
      note: ref.state === "merged" ? "Merged on GitHub" : null,
      mergedAt: ref.state === "merged" ? (i.mergedAt ?? ctx.now().toISOString()) : i.mergedAt,
    }));
  }
}
