import {
  drainText,
  type FactoryDrain,
  type FactoryDrainStatus,
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLoop,
  type Project,
} from "@codeden/contracts";
import { type FactoryContext, factoryNotice, raiseInbox } from "./context";
import { stoppedLoop, stopWork } from "./controls";
import { awaitedProvider } from "./provider-wait";
import { recoverable } from "./recover";

/**
 * The kill switch's "Finish current work, then stop" (§10.1): a drain. Nothing new starts (no
 * intake, no classification, no new builds, no scout round, no issue filed), while the work in
 * flight when it began carries on to the end of its pipeline under the usual rules. Once none of
 * it is in flight any more, the loop stops by itself: the project kill switch turns on, as after
 * Stop now, with one inbox notice. Past its optional time limit it falls back to Stop now. The
 * drain is part of the persisted loop, so a restart keeps draining.
 */

/** Stages of work that is moving through its pipeline. */
const MOVING: FactoryItemStage[] = ["building", "verifying", "watching"];

/** Inbox item of a drain's end (one per project, refreshed by the next drain). */
export const drainInboxId = (projectId: string) => `inbox:factory-drained:${projectId}`;

/**
 * Whether an item is still in flight: moving through its pipeline, or failed for a reason
 * outside its code while the loop still puts it back by itself, unless that waits on a provider
 * that can't take work (signed out, at its usage limit), which never holds a drain, as it never
 * holds the work-in-progress limit. `queued`: a drain's item back in the queue (its builder gone,
 * or rebuilt) is in flight too.
 */
function stillInFlight(
  ctx: FactoryContext,
  item: FactoryItem,
  available: readonly string[],
  queued: boolean,
): boolean {
  if (MOVING.includes(item.stage)) return true;
  if (item.stage === "backlog") return queued;
  if (item.stage !== "failed" || !recoverable(item)) return false;
  return awaitedProvider(ctx, item, available) === undefined;
}

/** The work in flight right now: what a drain that begins now waits for. */
export function workInFlight(ctx: FactoryContext, projectId: string): FactoryItem[] {
  const available = ctx.sessions.providers();
  return ctx.store
    .items(projectId, [...MOVING, "failed"])
    .filter((i) => stillInFlight(ctx, i, available, false));
}

/**
 * The drain's items still in flight, and all of its items. Work that is moving without having
 * started from the queue during the drain (the revert of a merge whose CI on main failed) joins
 * it, so a drain never stops while anything is moving.
 */
export function drainProgress(
  ctx: FactoryContext,
  projectId: string,
  drain: FactoryDrain,
): { inFlight: FactoryItem[]; itemIds: string[] } {
  const available = ctx.sessions.providers();
  const ids = new Set(drain.itemIds);
  for (const i of ctx.store.items(projectId, MOVING)) ids.add(i.id);
  const inFlight = [...ids].flatMap((id) => {
    const item = ctx.store.item(id);
    return item && stillInFlight(ctx, item, available, true) ? [item] : [];
  });
  return { inFlight, itemIds: [...ids] };
}

/** The drain as the panel, the Factory view and the PM see it; null when none runs. */
export function drainStatus(
  ctx: FactoryContext,
  projectId: string,
  loop: FactoryLoop,
): FactoryDrainStatus | null {
  if (!loop.drain) return null;
  const { inFlight, itemIds } = drainProgress(ctx, projectId, loop.drain);
  return {
    since: loop.drain.startedAt,
    inFlight: inFlight.length,
    total: itemIds.length,
    deadline: loop.drain.deadline,
  };
}

/**
 * Begin a drain: snapshot the work in flight, stop the scout and its area reviewers (they only
 * find new work) and close their round. A drain already running only changes its time limit,
 * when one is sent (`null` removes it). The caller saves the returned loop, and ends the drain at
 * once when nothing is in flight (`advanceDrain`).
 */
export async function startDrain(
  ctx: FactoryContext,
  projectId: string,
  limitMin: number | null | undefined,
): Promise<{ loop: FactoryLoop; stoppedSessions: string[] }> {
  const now = ctx.now();
  const loop = ctx.store.loopOrNew(projectId, now);
  const deadline = limitMin ? new Date(now.getTime() + limitMin * 60_000).toISOString() : null;
  if (loop.drain) {
    if (limitMin === undefined) return { loop, stoppedSessions: [] };
    return { loop: { ...loop, drain: { ...loop.drain, deadline } }, stoppedSessions: [] };
  }
  const stoppedSessions = await ctx.sessions.stopScouts(projectId);
  const at = now.toISOString();
  const drain: FactoryDrain = {
    startedAt: at,
    itemIds: workInFlight(ctx, projectId).map((i) => i.id),
    deadline,
  };
  const scout = loop.scout.round ? { ...loop.scout, round: null, lastRoundAt: at } : loop.scout;
  ctx.log?.(`factory: ${projectId}: draining ${drain.itemIds.length} items in flight`);
  return {
    loop: { ...loop, drain, scout, state: loop.state === "paused" ? "paused" : "draining" },
    stoppedSessions,
  };
}

/**
 * One drain step, after the work in flight moved. With nothing of it in flight any more, the
 * loop stops by itself; past its time limit, everything stops at once. Returns the loop, with
 * the state `stopped` when the drain ended (the caller saves it and ends the tick).
 */
export async function advanceDrain(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const drain = loop.drain;
  if (!drain) return loop;
  const { inFlight, itemIds } = drainProgress(ctx, project.id, drain);
  const current = { ...drain, itemIds };
  if (inFlight.length === 0) return finishDrain(ctx, project, loop, current);
  if (drain.deadline && ctx.now().getTime() >= Date.parse(drain.deadline)) {
    return drainTimedOut(ctx, project, loop, current, inFlight);
  }
  return itemIds.length === drain.itemIds.length ? loop : { ...loop, drain: current };
}

/** Nothing is in flight: the kill switch turns on and the loop stops, with one notice. */
function finishDrain(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  drain: FactoryDrain,
): FactoryLoop {
  ctx.setKillSwitch(project.id, true);
  const items = drain.itemIds.flatMap((id) => ctx.store.item(id) ?? []);
  const n = items.length;
  const title = `Factory stopped after finishing ${n} item${n === 1 ? "" : "s"}`;
  const body = [
    `${project.name}: the factory finished the work it had in flight and stopped. It takes on no new work until you resume it.`,
    ...(n > 0 ? ["", ...items.map((i) => `- ${itemLine(i)}`)] : []),
  ].join("\n");
  announce(ctx, project, drain, { title, body, failure: false });
  ctx.log?.(`factory: ${project.id}: drained (${n} items), stopped`);
  return stoppedLoop(loop);
}

/** The time limit ran out: Stop now, with a notice of what was still in flight. */
async function drainTimedOut(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  drain: FactoryDrain,
  inFlight: FactoryItem[],
): Promise<FactoryLoop> {
  ctx.setKillSwitch(project.id, true);
  await stopWork(ctx, project.id);
  const n = inFlight.length;
  const title = `Factory stopped: the drain's time limit ran out with ${n} item${n === 1 ? "" : "s"} in flight`;
  const body = [
    `${project.name}: the factory stopped everything at once, as Stop now does. Work that hadn't opened a pull request went back to the queue; open pull requests stay open.`,
    "",
    "Still in flight:",
    ...inFlight.map((i) => `- ${i.title}${i.pr ? ` (#${i.pr.number})` : ""}`),
  ].join("\n");
  announce(ctx, project, drain, { title, body, failure: true });
  ctx.log?.(`factory: ${project.id}: drain time limit reached, stopped`);
  return stoppedLoop(loop);
}

/** The drain's end: one inbox item, and a word to the PM (no wake). */
function announce(
  ctx: FactoryContext,
  project: Project,
  drain: FactoryDrain,
  opts: { title: string; body: string; failure: boolean },
): void {
  raiseInbox(ctx, {
    id: drainInboxId(project.id),
    kind: opts.failure ? "run_failed" : "automation_result",
    notify: opts.failure ? "failure" : "factory",
    priority: opts.failure ? "high" : "normal",
    projectId: project.id,
    title: opts.title,
    body: opts.body,
  });
  factoryNotice(ctx, {
    id: `factory.stopped:${project.id}:${drain.startedAt}`,
    projectId: project.id,
    target: "pm",
    event: "stopped",
    title: opts.title,
    text: `${opts.body}\n\nThe user resumes it (Release kill switch).`,
    itemIds: drain.itemIds,
    wake: false,
  });
}

/** "Add a counter (#12): merged". */
function itemLine(i: FactoryItem): string {
  const ref = i.pr ? ` (#${i.pr.number})` : "";
  const why = i.reason ? `: ${i.reason}` : "";
  const outcome: Partial<Record<FactoryItemStage, string>> = {
    merged: "merged",
    reverted: "merged, then reverted",
    rejected: `rejected${why}`,
    escalated: `waits for you${why}`,
    failed: `failed${why}`,
  };
  return `${i.title}${ref}: ${outcome[i.stage] ?? i.stage}`;
}

/** "Draining: 2 items in flight", for the digests. */
export function drainLine(ctx: FactoryContext, projectId: string, loop: FactoryLoop) {
  const status = drainStatus(ctx, projectId, loop);
  return status ? drainText(status.inFlight) : null;
}
