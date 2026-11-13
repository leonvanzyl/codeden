import {
  checksPassed,
  type FactoryItem,
  type FactoryPrEntry,
  type FactoryPrState,
  type Project,
} from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { localDay } from "./policy";
import { isRebasing, isUpdating, mergeQueue } from "./queue";
import { rebaseAsks } from "./rebase";
import { replacedPrs, unreplacedOriginal } from "./rebuild";
import { mayAutoMerge } from "./trust";

/**
 * The factory's pull requests as the panel shows them (§10.1 visibility): the merge queue in
 * the order it merges, then every other PR the loop owns (being checked, rebased, rebuilt or
 * waiting for a person), then today's merges. Derived from the items alone: no GitHub call.
 */

function ciState(item: FactoryItem): FactoryPrState {
  return item.checks.some((c) => c.name === "ci" && c.state === "pending")
    ? "waiting_ci"
    : "checking";
}

/** The state of an item's PR, given its place in the merge queue (null: not queued). */
export function prState(item: FactoryItem, project: Project, queued: boolean): FactoryPrState {
  switch (item.stage) {
    case "verifying":
      if (isRebasing(item)) return "rebasing";
      if (queued) {
        if (isUpdating(item)) return "updating";
        return checksPassed(item) ? "queued" : ciState(item);
      }
      if (checksPassed(item) && !mayAutoMerge(item, project.factoryLimits))
        return "waiting_for_you";
      return ciState(item);
    case "backlog":
      return "rebuilding";
    case "building":
      return item.pr ? "checking" : "rebuilding";
    case "watching":
    case "merged":
      return "merged";
    case "escalated":
      return rebaseAsks(item) > 0 ? "rebasing" : "waiting_for_you";
    case "failed":
      if (item.failureKind === "stuck") return "stuck";
      if (rebaseAsks(item) > 0) return "rebasing";
      return item.failureKind === "infrastructure" ? "checking" : "waiting_for_you";
    default:
      return "checking";
  }
}

function isOpen(item: FactoryItem): boolean {
  return item.pr?.state === "open" || item.pr?.state === "draft";
}

export function pullRequests(
  ctx: FactoryContext,
  project: Project,
  items: FactoryItem[],
): FactoryPrEntry[] {
  const queue = mergeQueue(ctx, project);
  const position = new Map(queue.map((i, n) => [i.id, n + 1]));
  const today = localDay(ctx.now());
  const entry = (i: FactoryItem, pr: NonNullable<FactoryItem["pr"]>): FactoryPrEntry => ({
    itemId: i.id,
    title: i.title,
    pr,
    state: prState(i, project, position.has(i.id)),
    queuePosition: position.get(i.id) ?? null,
    note: i.note ?? i.reason,
  });
  const queued = queue.flatMap((i) => (i.pr ? [entry(i, i.pr)] : []));
  const others: FactoryPrEntry[] = [];
  const merged: FactoryPrEntry[] = [];
  for (const i of items) {
    // PRs a newer one replaced stay listed until the factory has closed them.
    for (const old of replacedPrs(i)) {
      const ref = ctx.github.prRef(project.id, old.number) ?? {
        number: old.number,
        url: i.rebuiltFrom?.number === old.number ? i.rebuiltFrom.url : "",
        state: "open" as const,
      };
      if (!ref.url || ref.state === "closed" || ref.state === "merged") continue;
      others.push({
        itemId: i.id,
        title: i.title,
        pr: ref,
        state: "superseded",
        queuePosition: null,
        note: i.pr
          ? `Superseded by #${i.pr.number}: closing it`
          : "Superseded: closes once the new pull request is open",
      });
    }
    if (position.has(i.id)) continue;
    if (
      i.stage === "watching" ||
      (i.stage === "merged" && i.mergedAt && localDay(new Date(i.mergedAt)) === today)
    ) {
      if (i.pr) merged.push(entry(i, i.pr));
    } else if (!i.pr) {
      // A rebuild's original PR stays listed until its replacement exists, also when the
      // rebuild ended without one.
      const original = OWNING_STAGES.includes(i.stage) ? unreplacedOriginal(ctx, i) : null;
      if (original) others.push(entry(i, original));
    } else if (isOpen(i) && OWNING_STAGES.includes(i.stage)) {
      others.push(entry(i, i.pr));
    }
  }
  return [...queued, ...others, ...merged].slice(0, MAX_ENTRIES);
}

/** Stages in which an item's open PR is listed (merged ones are listed as merges). */
const OWNING_STAGES: FactoryItem["stage"][] = [
  "backlog",
  "building",
  "verifying",
  "escalated",
  "failed",
];

/** Most PRs the panel lists (the queue comes first, so it is never cut). */
const MAX_ENTRIES = 40;
