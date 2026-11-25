import {
  FACTORY_HOLD_LABEL,
  type FactoryHeldIssue,
  type FactoryHold,
  type FactoryHoldBy,
  type FactoryHoldRequest,
  type FactoryHoldResult,
  type FactoryItem,
  type FactoryLoop,
  type FactoryReleaseRequest,
  type GithubIssue,
  isFactoryMode,
} from "@codeden/contracts";
import { conflict, errorMessage, notFound } from "../errors";
import type { FactoryContext } from "./context";
import { ACTIVE_STAGES, WAITING_STAGES } from "./store";

/**
 * Held work (§10.1): the `factory:hold` label (`FACTORY_HOLD_LABEL`) keeps an issue out of the
 * loop. Intake never takes a held issue in, an item of it still waiting in the queue is parked
 * (never classified or started), and work already under way carries on. Removing the label, on
 * GitHub or with `factory_release_issue`, releases it on the next tick. The label is the hold;
 * the loop only keeps why (`FactoryLoop.holds`), for the factory view.
 */

/** Whether a synced issue is held: open, with the hold label. */
export function issueHeld(issue: GithubIssue | null | undefined): boolean {
  return issue?.state === "open" && issue.labels.includes(FACTORY_HOLD_LABEL);
}

/**
 * Whether an item's issue is held, which parks the item while it waits in the queue. Never an
 * automatic revert: it carries the reverted item's issue, and the default branch is red until it
 * lands.
 */
export function itemHeld(ctx: FactoryContext, item: FactoryItem): boolean {
  if (!item.issue || item.source === "revert") return false;
  return issueHeld(ctx.github.issue(item.projectId, item.issue.number));
}

/** The loop without the records of issues no longer held (label removed, issue closed). */
export function settleHolds(
  ctx: FactoryContext,
  projectId: string,
  loop: FactoryLoop,
): FactoryLoop {
  const holds = loop.holds.filter((h) => issueHeld(ctx.github.issue(projectId, h.issueNumber)));
  return holds.length === loop.holds.length ? loop : { ...loop, holds };
}

/**
 * The issues the loop skips for their hold, oldest first, for the factory view: an issue whose
 * item waits in the queue (parked), and every other labelled issue that has no item — including
 * one intake would never take in on its own (opened before the factory was switched on), since
 * `intake.ts` refuses every labelled issue and hiding it would hide work the loop is refusing.
 * `items` are the project's items, newest first; an issue whose work is under way or done isn't
 * listed. Each entry says what holds it: a record CodeDen made (`recorded`) or the label alone,
 * put on the issue by hand on GitHub (`label`).
 */
export function heldIssues(
  ctx: FactoryContext,
  projectId: string,
  loop: FactoryLoop,
  items: FactoryItem[],
): FactoryHeldIssue[] {
  const byIssue = new Map<number, FactoryItem>();
  for (const i of items) {
    if (i.issue && i.source !== "revert" && !byIssue.has(i.issue.number)) {
      byIssue.set(i.issue.number, i);
    }
  }
  const records = new Map(loop.holds.map((h) => [h.issueNumber, h]));
  return ctx.github
    .openIssues(projectId)
    .filter(issueHeld)
    .sort((a, b) => a.number - b.number)
    .flatMap((issue) => {
      const item = byIssue.get(issue.number);
      const hold = records.get(issue.number);
      // Held work under way or done is listed with the rest of it, not here.
      if (item && !WAITING_STAGES.includes(item.stage)) return [];
      return [
        {
          issue: { number: issue.number, url: issue.url, title: issue.title },
          itemId: item?.id ?? null,
          kind: hold ? ("recorded" as const) : ("label" as const),
          reason: hold?.reason ?? null,
          by: hold?.by ?? null,
          since: hold?.at ?? null,
        },
      ];
    });
}

/**
 * `factory_hold_issue`: put the hold label on an open issue and record why. Holding it again
 * replaces the reason. Work already under way isn't stopped: the answer says how to stop it.
 */
export async function holdIssue(
  ctx: FactoryContext,
  projectId: string,
  req: FactoryHoldRequest,
  by: FactoryHoldBy,
): Promise<FactoryHoldResult> {
  const issue = knownIssue(ctx, projectId, req.issueNumber);
  if (issue.state !== "open") {
    throw conflict(`Issue #${issue.number} is closed: there is nothing to hold`, "issue_closed");
  }
  await ctx.github.labelIssue(projectId, issue.number, [FACTORY_HOLD_LABEL]);
  const record: FactoryHold = {
    issueNumber: issue.number,
    reason: req.reason ?? null,
    by,
    at: ctx.now().toISOString(),
  };
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const others = loop.holds.filter((h) => h.issueNumber !== issue.number);
  ctx.store.saveLoop({ ...loop, holds: [...others, record] });
  if (req.reason) {
    await comment(
      ctx,
      projectId,
      issue.number,
      `held out of the factory loop by ${byWhom(by)}`,
      req.reason,
    );
  }
  const item = itemOf(ctx, projectId, issue.number);
  return {
    issueNumber: issue.number,
    held: true,
    itemId: item?.id ?? null,
    stage: item?.stage ?? null,
    message: heldMessage(issue.number, item),
  };
}

/**
 * `factory_release_issue`: take the hold label off and drop the record. The loop picks the issue
 * up on its next tick: intake takes it in, or its parked item goes on from the queue. An issue
 * that wasn't held is answered as such, never refused.
 */
export async function releaseIssue(
  ctx: FactoryContext,
  projectId: string,
  req: FactoryReleaseRequest,
  by: FactoryHoldBy,
): Promise<FactoryHoldResult> {
  const issue = knownIssue(ctx, projectId, req.issueNumber);
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const recorded = loop.holds.some((h) => h.issueNumber === issue.number);
  const labelled = issue.labels.includes(FACTORY_HOLD_LABEL);
  const item = itemOf(ctx, projectId, issue.number);
  const result = { issueNumber: issue.number, held: false, itemId: item?.id ?? null };
  if (!labelled && !recorded) {
    return { ...result, stage: item?.stage ?? null, message: `#${issue.number} wasn't held.` };
  }
  if (labelled) await ctx.github.unlabelIssue(projectId, issue.number, [FACTORY_HOLD_LABEL]);
  if (recorded) {
    ctx.store.saveLoop({
      ...loop,
      holds: loop.holds.filter((h) => h.issueNumber !== issue.number),
    });
  }
  const parked = item && WAITING_STAGES.includes(item.stage) ? item : null;
  const released = parked && req.reason ? noteRelease(ctx, parked, by, req.reason) : item;
  if (req.reason) {
    await comment(
      ctx,
      projectId,
      issue.number,
      `released back into the factory loop by ${byWhom(by)}`,
      req.reason,
    );
  }
  return {
    ...result,
    stage: released?.stage ?? null,
    message: parked
      ? `Released: #${issue.number} goes on from the queue on the factory's next check.`
      : item
        ? `Released: #${issue.number} is ${item.stage}; nothing waits on the hold any more.`
        : `Released: the factory takes #${issue.number} in on its next check.`,
  };
}

/** The issue as last synced; 404 when CodeDen hasn't seen it, 409 outside a GitHub factory. */
function knownIssue(ctx: FactoryContext, projectId: string, number: number): GithubIssue {
  if (!isFactoryMode(ctx.projects.get(projectId).autonomyMode)) {
    throw conflict("The factory isn't on for this project", "not_a_factory");
  }
  if (!ctx.github.isGithubProject(projectId)) {
    throw conflict("Not a GitHub project", "not_a_github_project");
  }
  const issue = ctx.github.issue(projectId, number);
  if (!issue) {
    throw notFound(
      `Issue #${number} isn't known: it hasn't been synced from GitHub`,
      "issue_not_found",
    );
  }
  return issue;
}

/** The issue's newest work item (never an automatic revert, which carries the issue it reverted). */
function itemOf(ctx: FactoryContext, projectId: string, number: number): FactoryItem | undefined {
  return ctx.store
    .items(projectId)
    .find((i) => i.issue?.number === number && i.source !== "revert");
}

function heldMessage(number: number, item: FactoryItem | undefined): string {
  if (!item) return `Held: the factory won't take #${number} in until it is released.`;
  if (WAITING_STAGES.includes(item.stage)) {
    return `Held: #${number} is parked in the queue (not classified or started) until it is released.`;
  }
  if (ACTIVE_STAGES.includes(item.stage)) {
    return `Held, but #${number} is already in progress (${item.stage}), so it carries on. To stop it, call stop_session on its session with a reason: that is recorded as your stop, not a failure.`;
  }
  return `Held: #${number} is ${item.stage}; if it runs again, it waits in the queue until it is released.`;
}

function noteRelease(
  ctx: FactoryContext,
  item: FactoryItem,
  by: FactoryHoldBy,
  reason: string,
): FactoryItem {
  const note = `Released by ${by === "pm" ? "the PM" : "you"}: ${reason}`;
  return ctx.store.updateItem(item.id, (i) => ({ ...i, note }), { touch: false });
}

function byWhom(by: FactoryHoldBy): string {
  return by === "pm" ? "the project manager" : "a maintainer";
}

/** Say on the issue what happened and why; a comment GitHub refuses is only logged. */
async function comment(
  ctx: FactoryContext,
  projectId: string,
  number: number,
  what: string,
  reason: string,
): Promise<void> {
  await ctx.github
    .comment(projectId, number, `**CodeDen software factory**: ${what}: ${reason}`)
    .catch((error: unknown) => ctx.log?.(`factory: comment on #${number}: ${errorMessage(error)}`));
}
