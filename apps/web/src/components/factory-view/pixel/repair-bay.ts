import {
  type StoppedAction,
  type StoppedKind,
  stoppedAction,
  stoppedKind,
  stoppedLabel,
} from "@/components/factory/stopped-items";
import { cardNumber, type ViewCard, type ViewPipeline } from "../stages";

/**
 * The repair bay (#264): the small corner of the floor for work that stopped and waits on a
 * person. It holds at most three crates, one per kind (needs a retry, stuck, yours to merge),
 * each with a count badge; hovering a crate lists its items with why each stopped and the button
 * that moves it on. Agents waiting on an answer aren't here: they stand at their station with a
 * raised hand. Pure.
 */

export interface BayEntry {
  card: ViewCard;
  /** Why it stopped, from the shared stopped-items rule. */
  label: string;
  action: StoppedAction | null;
}

export interface BayCrate {
  kind: StoppedKind;
  title: string;
  entries: BayEntry[];
}

export const BAY_TITLE: Record<StoppedKind, string> = {
  retry: "Needs a retry",
  stuck: "Stuck",
  merge: "Yours to merge",
};

const ORDER: StoppedKind[] = ["retry", "stuck", "merge"];

/** The kind of a Needs you card, when the shared rule doesn't say (a need without a stop). */
function kindOf(card: ViewCard): StoppedKind | null {
  const kind = stoppedKind(card.item, card.pr);
  if (kind) return kind;
  if (card.need?.kind === "merge") return "merge";
  if (card.need?.kind === "retry" || card.need?.kind === "retry_or_dismiss") return "retry";
  return null;
}

/** The bay's crates, in a fixed order, only those with something in them. */
export function repairBay(pipeline: ViewPipeline): BayCrate[] {
  const stuckElsewhere = Object.values(pipeline.stages)
    .flat()
    .filter((c) => c.pr?.state === "stuck");
  const groups = new Map<StoppedKind, BayEntry[]>();
  for (const card of [...pipeline.needsYou, ...stuckElsewhere]) {
    if (card.need?.kind === "answer") continue;
    const kind = kindOf(card);
    if (!kind) continue;
    const entry: BayEntry = {
      card,
      label: stoppedLabel(card.item, card.pr) ?? card.need?.label ?? BAY_TITLE[kind],
      action: stoppedAction(card.item, card.pr),
    };
    groups.set(kind, [...(groups.get(kind) ?? []), entry]);
  }
  return ORDER.filter((k) => groups.has(k)).map((kind) => ({
    kind,
    title: BAY_TITLE[kind],
    entries: groups.get(kind) ?? [],
  }));
}

/** Every item in the bay. */
export function bayCount(bay: readonly BayCrate[]): number {
  return bay.reduce((n, c) => n + c.entries.length, 0);
}

/**
 * What a crate holds, in words, for its button's accessible description: each item and why it
 * stopped ("#143 Show delivery estimates: Stopped after 2 revise rounds; needs a re-review.").
 */
export function bayDescription(crate: BayCrate): string {
  return crate.entries
    .map((e) => `${cardNumber(e.card.item)} ${e.card.item.title}: ${e.label}.`)
    .join(" ");
}
