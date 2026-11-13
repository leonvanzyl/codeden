import { z } from "zod";
import { GitHubPrRef, Id } from "./common";

/**
 * The factory's pull requests (§10.1, Merge): the loop owns every PR it opened until it merges
 * or closes, whatever its item's stage. It keeps them free of conflicts, merges them one at a
 * time (the merge queue) and rebuilds work whose PR keeps conflicting.
 */

/**
 * Why a work item failed:
 * - `checks`: its own work fell short (merge checks after its revise rounds, a step it never
 *   reported);
 * - `infrastructure`: something outside its code, such as the builder or reviewer session dying
 *   or CI never starting while Actions can run. The loop puts it back by itself on the next
 *   tick after the cause is gone, at most three times;
 * - `stuck`: it needs a person: it already used its rebuild, or CI can never run on the
 *   repository (Actions off, no active workflow).
 *
 * Null on items that never failed, and on failures recorded before this existed (the loop
 * reads those from their reason).
 */
export const FactoryFailureKind = z.enum(["checks", "infrastructure", "stuck"]);
export type FactoryFailureKind = z.infer<typeof FactoryFailureKind>;

/**
 * A factory PR's state, as the panel shows it:
 * - `checking`: the merge checks are running (the review, tests, evidence);
 * - `waiting_ci`: CI is running, or yet to start, on the head commit;
 * - `queued`: every check passed and it waits for its turn to merge;
 * - `updating`: at the head of the queue, being brought up to date with the default branch;
 * - `rebasing`: it has merge conflicts and an agent is rebasing it;
 * - `rebuilding`: it kept conflicting, so its work is being redone from the default branch;
 *   the new PR replaces it;
 * - `superseded`: a newer PR for the same work replaced it (a rebuild's, or an integrator's);
 *   the factory closes it with a link to the new one, retrying until GitHub accepts;
 * - `merged`: merged by the factory (or on GitHub) today;
 * - `waiting_for_you`: a person merges it (auto-merge off, an untrusted author, a protected
 *   area, or checks that failed after the revise rounds); the factory still keeps it free of
 *   conflicts;
 * - `stuck`: it needs a person before anything else can happen.
 */
export const FactoryPrState = z.enum([
  "checking",
  "waiting_ci",
  "queued",
  "updating",
  "rebasing",
  "rebuilding",
  "superseded",
  "merged",
  "waiting_for_you",
  "stuck",
]);
export type FactoryPrState = z.infer<typeof FactoryPrState>;

/** One pull request the factory owns, for the panel's merge queue. */
export const FactoryPrEntry = z.object({
  itemId: Id,
  title: z.string(),
  pr: GitHubPrRef,
  state: FactoryPrState,
  /** Place in the merge queue (1 merges next); null when it isn't queued. */
  queuePosition: z.int().positive().nullable(),
  /** The loop's last note about it (why it waits, what it is doing). */
  note: z.string().nullable(),
});
export type FactoryPrEntry = z.infer<typeof FactoryPrEntry>;
