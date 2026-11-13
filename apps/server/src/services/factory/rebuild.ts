import type { FactoryItem, FactoryLoop, GitHubPrRef, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { sessionsToArchive } from "./cleanup";
import { type FactoryContext, factoryNotice } from "./context";
import { closeInboxFor, retargetInboxFor } from "./merge";
import { markStuck } from "./outcomes";

/**
 * Rebuilds (§10.1): a PR that still conflicts after three requests to rebase is usually cheaper
 * to redo than to rescue. The same item goes back to the queue with its investigation (the
 * reproduction or the spec) kept and a fresh builder from the latest default branch; once the
 * new PR is open, the old one is closed with a link to it. One rebuild per item: an item that
 * would need a second one is stuck and goes to the user.
 */

/** Nudge set once the PR a rebuild replaced was closed. */
const REPLACED_CLOSED = "replaced_closed";
/** `supersede_<number>`: a PR an integrator's new PR replaced, still to be closed. */
const SUPERSEDE = "supersede_";

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
    nudges: pendingClosures(i.nudges),
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

/** A PR the item no longer stands for and the factory still has to close. */
export interface ReplacedPr {
  number: number;
  /** Why it was replaced: a rebuild, or an integrator's new PR. */
  by: "rebuild" | "integrator";
}

/**
 * The item's PRs waiting to be closed because a newer one replaced them: a rebuild's old PR
 * once the new one is open, and PRs an integrator replaced (`supersede_<number>`).
 */
export function replacedPrs(item: FactoryItem): ReplacedPr[] {
  const out: ReplacedPr[] = [];
  const old = item.rebuiltFrom;
  if (old && item.pr && old.number !== item.pr.number && !item.nudges[REPLACED_CLOSED]) {
    out.push({ number: old.number, by: "rebuild" });
  }
  for (const k of Object.keys(item.nudges)) {
    const n = Number(k.slice(SUPERSEDE.length));
    if (k.startsWith(SUPERSEDE) && Number.isInteger(n)) out.push({ number: n, by: "integrator" });
  }
  return out;
}

/** The nudges that must outlive a fresh attempt: PRs still to be closed. */
export function pendingClosures(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  return Object.fromEntries(Object.entries(nudges).filter(([k]) => k.startsWith(SUPERSEDE)));
}

/**
 * Close the PRs the factory's items replaced, with a link to the replacement. Its own loop step,
 * whatever the item's stage, so a replacement that merges (or an item that fails) never leaves
 * the old PR open: a close GitHub refused is tried again on the next tick until it succeeds.
 */
export async function closeReplacedPrs(ctx: FactoryContext, project: Project): Promise<void> {
  for (const item of ctx.store.items(project.id)) {
    const current = item.pr;
    for (const old of replacedPrs(item)) {
      const state = ctx.github.prRef(project.id, old.number)?.state ?? "open";
      if (isOpen(state)) {
        const why =
          old.by === "rebuild"
            ? "which redoes this work from the latest default branch"
            : "which resolves this pull request's merge conflicts";
        // Only after a rebuild of an adopted PR is there no newer PR yet to link to.
        const by = current ? `#${current.number} (${current.url}), ${why}` : "a newer pull request";
        try {
          await ctx.github.closePr(
            project.id,
            old.number,
            `Superseded by ${by}. Closed by the CodeDen factory.`,
          );
        } catch (error) {
          ctx.log?.(`factory: closing #${old.number}: ${errorMessage(error)}`);
          continue;
        }
      }
      const at = ctx.now().toISOString();
      ctx.store.updateItem(item.id, (i) => {
        if (old.by === "integrator") {
          const { [`${SUPERSEDE}${old.number}`]: _done, ...nudges } = i.nudges;
          return { ...i, nudges };
        }
        return {
          ...i,
          rebuiltFrom: i.rebuiltFrom
            ? { ...i.rebuiltFrom, state: isOpen(state) ? "closed" : state }
            : null,
          nudges: { ...i.nudges, [REPLACED_CLOSED]: at },
        };
      });
    }
  }
}

/**
 * An integrator on another branch than the PR's opened a new PR for the same work: the item
 * takes the new PR at once (its checks, conflicts and merge policy now follow it), and the old
 * one is closed with a link by `closeReplacedPrs`. The rebuild stays unused. Whatever waits on
 * the user about the old PR (ready, protected area, stuck) points at the new one.
 */
export function adoptAgentPr(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): FactoryItem {
  if (!item.pr || !item.builderSessionId) return item;
  const agent = ctx.repo.find(item.builderSessionId)?.session;
  if (!agent) return item;
  const own = ctx.github.prForSession(project.id, agent.id, agent.branch);
  if (!own || own.number === item.pr.number || !isOpen(own.state)) return item;
  const old = item.pr;
  const at = ctx.now().toISOString();
  const adopted = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    pr: own,
    note: `Took over #${own.number}, which replaces #${old.number}`,
    nudges: { ...i.nudges, [`${SUPERSEDE}${old.number}`]: at },
  }));
  retargetInboxFor(ctx, item.id, own);
  return adopted;
}
