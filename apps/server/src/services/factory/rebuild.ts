import type { FactoryItem, FactoryLoop, GitHubPrRef, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { sessionsToArchive } from "./cleanup";
import { type FactoryContext, factoryNotice } from "./context";
import { closeInboxFor } from "./merge";
import { markStuck } from "./outcomes";

/**
 * Rebuilds (§10.1): a PR that still conflicts after three requests to rebase is usually cheaper
 * to redo than to rescue. The same item goes back to the queue with its investigation (the
 * reproduction or the spec) kept and a fresh builder from the latest default branch; once the
 * new PR is open, the old one is closed with a link to it. One rebuild per item: an item that
 * would need a second one is stuck and goes to the user.
 */

/** Nudge set once the PR a rebuild (or an integrator's new PR) replaced was closed. */
const REPLACED_CLOSED = "replaced_closed";

function isOpen(state: GitHubPrRef["state"]): boolean {
  return state === "open" || state === "draft";
}

export async function rebuild(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  /** Why, completing "#N …". */
  why: string,
): Promise<FactoryLoop> {
  const old = item.pr;
  if (!old) return loop;
  if (item.rebuiltFrom) {
    return markStuck(
      ctx,
      loop,
      item,
      `Pull request #${old.number} ${why}, and the work was already rebuilt from the default branch once`,
      "Resolve the conflicts on the pull request by hand and merge it, or close it.",
    );
  }
  const earlier = item.sessionsArchivedAt ? [] : sessionsToArchive(ctx, item).map((s) => s.id);
  const state = ctx.github.prRef(project.id, old.number)?.state ?? old.state;
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "backlog",
    rebuiltFrom: { ...old, state },
    pr: null,
    attempts: 0,
    review: null,
    checks: [],
    builderSessionId: null,
    builderProvider: null,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    nudges: {},
    reason: null,
    failureKind: null,
    note: `Rebuilding from the default branch: #${old.number} ${why}`,
    sessionsArchivedAt: null,
    earlierSessionIds: [...new Set([...i.earlierSessionIds, ...earlier])],
    mergedAt: null,
    finishedAt: null,
  }));
  closeInboxFor(ctx, item.id, "rebuilding");
  await ctx.github
    .comment(
      project.id,
      old.number,
      `This pull request ${why}, so the CodeDen factory is redoing the work from the latest default branch. It closes this pull request once the new one is open.`,
    )
    .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  factoryNotice(ctx, {
    id: `factory.rebuild:${item.id}`,
    projectId: project.id,
    target: "pm",
    event: "failed",
    title: `Rebuilding #${old.number}: ${item.title}`,
    text: `#${old.number} ${why}; the work is redone from the default branch.`,
    itemIds: [item.id],
    wake: false,
  });
  return loop;
}

/**
 * The item's new PR is open: close the PR it replaces (a rebuild's old PR, or the PR an
 * integrator replaced with a new one) with a link to the new one. Retried every tick until done.
 */
export async function closeReplaced(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<void> {
  const old = item.rebuiltFrom;
  const current = item.pr;
  if (!old || !current || item.nudges[REPLACED_CLOSED] || old.number === current.number) return;
  const state = ctx.github.prRef(project.id, old.number)?.state ?? old.state;
  if (isOpen(state)) {
    try {
      await ctx.github.closePr(
        project.id,
        old.number,
        `Superseded by #${current.number} (${current.url}), which redoes this work from the latest default branch. Closed by the CodeDen factory.`,
      );
    } catch (error) {
      ctx.log?.(`factory: closing #${old.number}: ${errorMessage(error)}`);
      return;
    }
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    rebuiltFrom: i.rebuiltFrom
      ? { ...i.rebuiltFrom, state: isOpen(state) ? "closed" : state }
      : null,
    nudges: { ...i.nudges, [REPLACED_CLOSED]: at },
  }));
}

/**
 * An integrator on another branch than the PR's opened a new PR for the same work: the item
 * takes the new PR and the old one is closed with a link to it (as after a rebuild, but the
 * rebuild stays unused).
 */
export async function adoptAgentPr(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<FactoryItem> {
  if (!item.pr || !item.builderSessionId) return item;
  const agent = ctx.repo.find(item.builderSessionId)?.session;
  if (!agent) return item;
  const own = ctx.github.prForSession(project.id, agent.id, agent.branch);
  if (!own || own.number === item.pr.number || !isOpen(own.state)) return item;
  const old = item.pr;
  try {
    await ctx.github.closePr(
      project.id,
      old.number,
      `Superseded by #${own.number} (${own.url}), which resolves this pull request's merge conflicts. Closed by the CodeDen factory.`,
    );
  } catch (error) {
    ctx.log?.(`factory: closing #${old.number}: ${errorMessage(error)}`);
    return item;
  }
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    pr: own,
    note: `Took over #${own.number}, which replaces #${old.number}`,
  }));
}
