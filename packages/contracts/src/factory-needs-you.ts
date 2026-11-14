import { z } from "zod";
import type { FactoryItemStage } from "./factory-api";
import type { FactoryFailureKind } from "./factory-prs";

/**
 * "Needs you" (§10.1): the one definition of factory work that waits on a person. The Factory
 * view's lane and header count and the daily digest's "Waiting on you" all use it, so they
 * agree. Work the factory finishes or recovers by itself never counts.
 */

/**
 * What a person has to do:
 * - `merge`: review and merge its pull request (escalated, or every check passed and the
 *   factory doesn't merge it);
 * - `retry`: it stopped with its pull request still open (out of review rounds, or stuck);
 * - `retry_or_dismiss`: it stopped without a pull request;
 * - `answer`: its agent asked a question or for an approval.
 */
export const FactoryNeedKind = z.enum(["merge", "retry", "retry_or_dismiss", "answer"]);
export type FactoryNeedKind = z.infer<typeof FactoryNeedKind>;

/** How long a failure without an open pull request waits for a decision before it drops off. */
export const FACTORY_FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;

/** The work item's side of the decision (`FactoryItem` and `FactoryWorkItem` both fit). */
export interface FactoryNeedItem {
  stage: FactoryItemStage;
  failureKind: FactoryFailureKind | null;
  finishedAt: string | null;
  updatedAt: string;
  /** Revise rounds so far. */
  attempts: number;
}

/** What is known around the item. */
export interface FactoryNeedContext {
  /** Epoch milliseconds. */
  now: number;
  /** The factory still holds an open pull request for it. */
  ownsOpenPr: boolean;
  /** A failure outside its code that the loop still puts back by itself. */
  recovering?: boolean;
  /** Its pull request waits for a person to merge it. */
  prWaitsForYou?: boolean;
  /** Its agent waits on a person (a question or an approval). */
  agentWaiting?: boolean;
}

const LIVE: ReadonlySet<FactoryItemStage> = new Set([
  "candidate",
  "backlog",
  "building",
  "verifying",
  "watching",
]);

/** What a person has to do for the item now, or null when nothing waits on them. */
export function factoryNeed(
  item: FactoryNeedItem,
  ctx: FactoryNeedContext,
): FactoryNeedKind | null {
  if (item.stage === "escalated") return "merge";
  if (item.stage === "failed") {
    if (ctx.recovering) return null;
    if (ctx.ownsOpenPr) return "retry";
    const at = Date.parse(item.finishedAt ?? item.updatedAt);
    return ctx.now - at < FACTORY_FAILED_SHOWN_MS ? "retry_or_dismiss" : null;
  }
  if (!LIVE.has(item.stage)) return null;
  if (ctx.agentWaiting) return "answer";
  if (ctx.prWaitsForYou) return "merge";
  return null;
}

/** The need in a few words, e.g. "Review and merge PR #12" or "Retry: stopped after 3 review rounds". */
export function factoryNeedLabel(
  kind: FactoryNeedKind,
  item: Pick<FactoryNeedItem, "attempts"> & { prNumber: number | null },
): string {
  const pr = item.prNumber ? `PR #${item.prNumber}` : "its pull request";
  switch (kind) {
    case "merge":
      return `Review and merge ${pr}`;
    case "retry":
      return item.attempts > 0
        ? `Retry: stopped after ${item.attempts} review round${item.attempts === 1 ? "" : "s"}`
        : `Retry: stopped with ${pr} open`;
    case "retry_or_dismiss":
      return "Retry or dismiss: stopped without a pull request";
    case "answer":
      return "Answer the agent's question";
  }
}
