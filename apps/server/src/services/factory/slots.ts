import type { Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { freeSlots } from "./policy";
import { isBusy } from "./sessions";

/**
 * Who gets the next free agent slot (§10.1, Slot priority): finish before starting. Work closest
 * to a merge comes first; the order only decides who takes a slot that is free, and work in
 * flight is never interrupted.
 *
 * - `review`: a reviewer for a PR whose CI passed (a fresh review, a re-review after a revise
 *   round, a re-check of a conflict resolution);
 * - `repair`: a rebase or conflict resolution (a request to the PR's agent, an integrator) or a
 *   builder's revise round;
 * - `review_early`: a reviewer for a PR whose CI is still running;
 * - `build`: a builder resumed after a failure outside its code, then new builds from the queue;
 * - `scout`: the dark factory's scout and its area reviewers.
 */
export const SLOT_TIERS = ["review", "repair", "review_early", "build", "scout"] as const;
export type SlotTier = (typeof SLOT_TIERS)[number];

const rank = (tier: SlotTier) => SLOT_TIERS.indexOf(tier);

interface Board {
  /** Claims refused on the last tick, by key: they are served first on this one. */
  waited: Map<string, SlotTier>;
  /** Claims refused on this tick so far. */
  waiting: Map<string, SlotTier>;
  /** Keys that claimed on this tick (granted or not). */
  asked: Set<string>;
  /** Keys that claimed on the last tick: work that was granted a slot it couldn't use keeps its place. */
  askedBefore: Set<string>;
  /** Idle sessions woken on this tick: they hold a slot before their status says so. */
  woken: Set<string>;
}

/**
 * The slot queue of every project, in memory: a claim that finds no free slot waits, and on the
 * next tick work of a lower tier only gets a slot that is left after the waiting work of higher
 * tiers. A waiting claim that doesn't come back (its item moved on) stops counting after one
 * tick, so nothing waits on it for longer; a restart only loses one tick of ordering.
 */
export class SlotBoard {
  private readonly boards = new Map<string, Board>();

  private board(projectId: string): Board {
    let b = this.boards.get(projectId);
    if (!b) {
      b = {
        waited: new Map(),
        waiting: new Map(),
        asked: new Set(),
        askedBefore: new Set(),
        woken: new Set(),
      };
      this.boards.set(projectId, b);
    }
    return b;
  }

  /** A new tick: what waited on the last one is served first. */
  beginTick(projectId: string): void {
    const b = this.board(projectId);
    b.waited = b.waiting;
    b.waiting = new Map();
    b.askedBefore = b.asked;
    b.asked = new Set();
    b.woken = new Set();
  }

  /**
   * Waiting claims that go before work of `tier` named `key`: those of a higher tier (this
   * tick's, and the last tick's that haven't asked again yet) and, for work that didn't ask on
   * the last tick, those of its own tier that waited then (within a tier, what waited longer
   * goes first).
   */
  ahead(projectId: string, tier: SlotTier, key?: string): number {
    const b = this.board(projectId);
    const newcomer = key === undefined || !b.askedBefore.has(key);
    let n = 0;
    for (const [k, t] of b.waiting) if (k !== key && rank(t) < rank(tier)) n++;
    for (const [k, t] of b.waited) {
      if (k === key || b.asked.has(k)) continue;
      if (rank(t) < rank(tier) || (newcomer && rank(t) === rank(tier))) n++;
    }
    return n;
  }

  /**
   * Take a slot for work of `tier` when one is left after the higher tiers' waiting work, or
   * wait. `free` is the number of free slots now.
   */
  claim(projectId: string, tier: SlotTier, key: string, free: number): boolean {
    const b = this.board(projectId);
    const granted = free > this.ahead(projectId, tier, key);
    b.asked.add(key);
    if (granted) b.waiting.delete(key);
    else b.waiting.set(key, tier);
    return granted;
  }

  /** An idle session was woken with a granted slot. */
  woke(projectId: string, sessionId: string): void {
    this.board(projectId).woken.add(sessionId);
  }

  /** Sessions woken on this tick. */
  wokenThisTick(projectId: string): ReadonlySet<string> {
    return this.board(projectId).woken;
  }
}

/** Factory sessions holding a slot, counting idle ones woken on this tick (`except` left out). */
export function busySlots(ctx: FactoryContext, projectId: string, except?: string): number {
  const woken = ctx.slots.wokenThisTick(projectId);
  return ctx.sessions
    .list(projectId)
    .filter((s) => s.id !== except && (isBusy(s) || woken.has(s.id))).length;
}

/**
 * Claim an agent slot for work of `tier` (`key` names the work, e.g. `review:<item>`). With
 * `wake`, the session that takes it is an idle one a message wakes: it counts as busy at once.
 */
export function claimSlot(
  ctx: FactoryContext,
  project: Project,
  tier: SlotTier,
  key: string,
  wake?: string,
): boolean {
  const free = freeSlots(busySlots(ctx, project.id), project.factoryLimits);
  const granted = ctx.slots.claim(project.id, tier, key, free);
  if (granted && wake) ctx.slots.woke(project.id, wake);
  return granted;
}

/**
 * Slots the work named `key` (of `tier`) may take now without claiming each (the scout's area
 * reviewers): the free slots left after the waiting work that goes first. `except` is a session
 * whose slot is about to be handed on (the scout's own, once it has planned).
 */
export function slotsFor(
  ctx: FactoryContext,
  project: Project,
  tier: SlotTier,
  key: string,
  except?: string,
): number {
  const free = freeSlots(busySlots(ctx, project.id, except), project.factoryLimits);
  return Math.max(0, free - ctx.slots.ahead(project.id, tier, key));
}

/** The tier of a review: `review` once the PR's CI passed (or isn't required), else `review_early`. */
export function reviewTier(checks: ReadonlyArray<{ name: string; state: string }>): SlotTier {
  const ci = checks.find((c) => c.name === "ci")?.state;
  return ci === "pass" || ci === "skipped" ? "review" : "review_early";
}
