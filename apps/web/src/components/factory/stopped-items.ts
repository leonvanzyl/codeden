import {
  type FactoryPrEntry,
  type FactoryWorkItem,
  type StoppedItem,
  stoppedRetry,
} from "@codeden/contracts";

/**
 * Stopped factory work in a person's words (§10.1): why an item stopped and what to do about it.
 * Built on the contracts' `stoppedRetry` (the one rule for Retry), so the Factory view's repair
 * bay, the item page and the panel say the same thing.
 */

/**
 * - `retry`: it stopped (out of revise rounds, or a step that never finished) and Retry runs it
 *   again, re-reviewing its open pull request when it has one;
 * - `stuck`: it needs a person before anything else can happen (it already used its rebuild, CI
 *   can never run);
 * - `merge`: a person reviews and merges its pull request (a protected area, auto-merge off).
 */
export type StoppedKind = "retry" | "stuck" | "merge";

/** What a person does about it: Retry, or open the pull request to merge it. */
export type StoppedAction = "retry" | "open_pr";

type Item = Pick<
  FactoryWorkItem,
  "stage" | "pr" | "ownedPr" | "failureKind" | "attempts" | "reason" | "trust"
>;
type Pr = Pick<FactoryPrEntry, "state" | "note"> | null;

/** The item as the Retry rule reads it: its own PR, else the open one the factory still owns. */
function asStopped(item: Item): StoppedItem {
  return { ...item, pr: item.pr ?? item.ownedPr };
}

/** Which kind of stopped work it is; null when it isn't stopped. */
export function stoppedKind(item: Item, pr: Pr): StoppedKind | null {
  if (item.stage === "escalated" || pr?.state === "waiting_for_you") return "merge";
  if (item.stage === "failed")
    return item.failureKind === "stuck" || pr?.state === "stuck" ? "stuck" : "retry";
  return pr?.state === "stuck" ? "stuck" : null;
}

/** Why it is yours to merge, from the factory's reason or the PR's note. */
function mergeReason(item: Item, pr: Pr): string | null {
  const why = `${item.reason ?? ""} ${pr?.note ?? ""}`;
  if (/protected/i.test(why)) return "protected area";
  if (item.trust === "untrusted") return "untrusted author";
  if (/auto-merge is off/i.test(why)) return "auto-merge is off";
  return null;
}

/**
 * Why it stopped, in a few words: "Stopped after 2 revise rounds; needs a re-review", "Rebuilt
 * once and still conflicting", "Yours to merge: protected area". Null when it isn't stopped.
 */
export function stoppedLabel(item: Item, pr: Pr): string | null {
  const kind = stoppedKind(item, pr);
  if (!kind) return null;
  if (kind === "merge") {
    const why = mergeReason(item, pr);
    return why ? `Yours to merge: ${why}` : "Yours to merge";
  }
  const why = `${item.reason ?? ""} ${pr?.note ?? ""}`;
  if (kind === "stuck") {
    if (/conflict/i.test(why) && /rebuil/i.test(why)) return "Rebuilt once and still conflicting";
    if (/\b(actions|workflow)\b|CI can never|CI never/i.test(why))
      return "CI can't run on this repository";
    return "Stuck: needs a person";
  }
  // The shared rule's words, without the button's name: the action sits right beside them.
  const label = stoppedRetry(asStopped(item))?.label;
  if (label) return label.replace(/\s*\(Retry\)$/, "");
  return asStopped(item).pr
    ? "Stopped with its pull request open"
    : "Stopped without a pull request";
}

/** What a person does about it; null when there's nothing to do here. */
export function stoppedAction(item: Item, pr: Pr): StoppedAction | null {
  const kind = stoppedKind(item, pr);
  if (kind === "merge") return "open_pr";
  if (kind && stoppedRetry(asStopped(item))) return "retry";
  return null;
}
