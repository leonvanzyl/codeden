import { z } from "zod";
import { GitHubIssueRef, Id, Timestamp } from "./common";

/**
 * Keeping work out of the factory loop on purpose (§10.1, Held work): the hold label on an issue,
 * the PM's `factory_hold_issue` and `factory_release_issue`, the held issues the factory view
 * lists, and a stop the PM makes with a reason, which is recorded as its call rather than as a
 * failure.
 */

/**
 * The GitHub label that keeps an issue out of the factory loop while it is on the issue. Intake
 * never takes such an issue in, an item of it still waiting in the queue is parked, and work
 * already under way carries on. Removing the label releases it on the next tick.
 */
export const FACTORY_HOLD_LABEL = "factory:hold";

/** Longest reason for a hold, a release or a stop. */
export const FACTORY_HOLD_REASON_MAX = 500;

/** Who made the call: a person (the UI) or the project manager. */
export const FactoryHoldBy = z.enum(["user", "pm"]);
export type FactoryHoldBy = z.infer<typeof FactoryHoldBy>;

/**
 * A hold the factory recorded (`FactoryLoop.holds`): who held the issue, when and why. The label
 * on the issue is what holds it; this record only says why, so the factory view can show it.
 * It is dropped once the issue no longer carries the label or is closed.
 */
export const FactoryHold = z.object({
  issueNumber: z.int().positive(),
  /** Why it is held ("waiting on #412"); null when none was given. */
  reason: z.string().max(FACTORY_HOLD_REASON_MAX).nullable(),
  by: FactoryHoldBy,
  at: Timestamp,
});
export type FactoryHold = z.infer<typeof FactoryHold>;

const reason = z
  .string()
  .trim()
  .min(1)
  .max(FACTORY_HOLD_REASON_MAX)
  .optional()
  .describe(
    "Why, in a few words (e.g. 'waiting on #412', 'needs a decision on the API'). Recorded with the hold and posted on the issue.",
  );

/** `factory_hold_issue`: keep an open issue out of the factory loop. */
export const FactoryHoldRequest = z.object({
  issueNumber: z.int().positive().describe("The GitHub issue to hold"),
  reason,
});
export type FactoryHoldRequest = z.infer<typeof FactoryHoldRequest>;

/** `factory_release_issue`: let a held issue back into the factory loop. */
export const FactoryReleaseRequest = z.object({
  issueNumber: z.int().positive().describe("The held GitHub issue to release"),
  reason,
});
export type FactoryReleaseRequest = z.infer<typeof FactoryReleaseRequest>;

/**
 * What `factory_hold_issue` and `factory_release_issue` did: whether the issue is held now, its
 * work item if the factory has one (and that item's stage), and what happens next, in words.
 */
export const FactoryHoldResult = z.object({
  issueNumber: z.int().positive(),
  held: z.boolean(),
  itemId: Id.nullable(),
  stage: z.string().nullable(),
  message: z.string(),
});
export type FactoryHoldResult = z.infer<typeof FactoryHoldResult>;

/** What holds an issue: the record CodeDen made, or the label on GitHub alone. */
export const FactoryHoldKind = z.enum(["recorded", "label"]);
export type FactoryHoldKind = z.infer<typeof FactoryHoldKind>;

/**
 * An issue the loop skips because it carries the hold label (`FactoryStatus.held`): one intake
 * hasn't taken in, or one whose item waits in the queue, parked. Work already under way when its
 * issue was held carries on and is listed with the rest of the work in progress instead.
 */
export const FactoryHeldIssue = z.object({
  issue: GitHubIssueRef,
  /** Its work item, parked in the queue; null when intake hasn't taken the issue in. */
  itemId: Id.nullable(),
  /**
   * What holds it: `recorded` — CodeDen made a hold record for it (`factory_hold_issue`, or the UI)
   * and put the label on; `label` — the label alone, put on the issue by hand on GitHub, so there
   * is no record, reason or author to show.
   */
  kind: FactoryHoldKind,
  /** Why it is held, as recorded; null when the label was added on GitHub or without a reason. */
  reason: z.string().nullable(),
  /** Who held it through CodeDen; null when the label was added on GitHub. */
  by: FactoryHoldBy.nullable(),
  /** When it was held through CodeDen; null when unknown. */
  since: Timestamp.nullable(),
});
export type FactoryHeldIssue = z.infer<typeof FactoryHeldIssue>;

/**
 * A stop made on purpose (`FactoryItem.stop`): `stop_session` with a reason on the builder or
 * reviewer of a factory item. It is recorded on the item before the session stops, so when the
 * loop finds that session stopped the item stops as that call, with the reason, and never counts
 * towards the pause after failures in a row. Retry clears it.
 */
export const FactoryStop = z.object({
  /** The builder or reviewer session that was stopped. */
  sessionId: Id,
  reason: z.string().min(1).max(FACTORY_HOLD_REASON_MAX),
  by: FactoryHoldBy,
  at: Timestamp,
});
export type FactoryStop = z.infer<typeof FactoryStop>;

/** The item's reason once a stop made on purpose ended it: "Stopped by the PM: waiting on #412". */
export function factoryStopReason(stop: Pick<FactoryStop, "by" | "reason">): string {
  return `Stopped by ${stop.by === "pm" ? "the PM" : "you"}: ${stop.reason}`;
}
