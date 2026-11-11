import type { FactoryLimits, ProtectedAreas } from "@codeden/contracts";
import { matchingGlobs } from "./globs";
import { DEPLOY_GLOBS, mentionsTopic } from "./vision";

/**
 * Pure rules of the factory loop (§10.1). Everything here is deterministic and enforced by the
 * server, never left to agent judgement: budgets, slots, merge limits, pausing, reviewer choice
 * and the path heuristics the merge checks use.
 */

/** Local calendar day, `YYYY-MM-DD` (counters and digests are per local day). */
export function localDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Why the daily budget is used up, or null when there is budget left. */
export function budgetExceeded(
  spend: { usd: number; tokens: number },
  limits: FactoryLimits,
): string | null {
  const { usd, tokens } = limits.dailyBudget;
  if (usd !== undefined && spend.usd >= usd) {
    return `daily budget reached ($${spend.usd.toFixed(2)} of $${usd.toFixed(2)})`;
  }
  if (tokens !== undefined && spend.tokens >= tokens) {
    return `daily token budget reached (${spend.tokens} of ${tokens})`;
  }
  return null;
}

/** True when limits carry a daily budget (required for the software and dark factory). */
export function hasBudget(limits: FactoryLimits): boolean {
  return limits.dailyBudget.usd !== undefined || limits.dailyBudget.tokens !== undefined;
}

/** Free session slots under `maxConcurrentSessions`. */
export function freeSlots(activeSessions: number, limits: FactoryLimits): number {
  return Math.max(0, limits.maxConcurrentSessions - activeSessions);
}

/**
 * Whether another build may start while auto-merge is on: merges today plus work in flight
 * stay under the daily merge cap.
 */
export function mayBuild(mergesToday: number, inFlight: number, limits: FactoryLimits): boolean {
  return mergesToday + inFlight < limits.maxMergesPerDay;
}

/** Whether a merge may happen now. */
export function mayMerge(mergesToday: number, limits: FactoryLimits): boolean {
  return mergesToday < limits.maxMergesPerDay;
}

/** The loop pauses after this many failed merge checks or reverts in a row. */
export function shouldPause(consecutiveFailures: number, limits: FactoryLimits): boolean {
  return consecutiveFailures >= limits.pauseAfterConsecutiveFailures;
}

/** Providers tried for reviews, in order, when the author's provider is excluded. */
const REVIEW_ORDER = ["codex", "claude"];

export interface ReviewerChoice {
  provider: string;
  /** True when the reviewer runs on a different provider from the author. */
  crossProvider: boolean;
  /** Set when the review falls back to the author's provider. */
  note: string | null;
}

/**
 * The independent reviewer runs on a different provider from the author (Codex reviews
 * Claude's work and vice versa). With only one provider available it falls back to the same
 * provider and says so.
 */
export function pickReviewer(author: string | null, available: readonly string[]): ReviewerChoice {
  const others = available.filter((p) => p !== author);
  const preferred = [...REVIEW_ORDER, ...others].find((p) => others.includes(p));
  if (preferred) return { provider: preferred, crossProvider: true, note: null };
  const fallback = author ?? available[0] ?? "claude";
  return {
    provider: fallback,
    crossProvider: false,
    note: `No provider other than ${fallback} is available; the review ran on the same provider as the author.`,
  };
}

const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const NON_CODE =
  /\.(md|mdx|txt|rst|json|ya?ml|toml|ini|lock|svg|png|jpe?g|gif|webp|ico)$|(^|\/)(LICENSE|\.gitignore|\.editorconfig)$/i;

export const isTestFile = (path: string) => TEST_FILE.test(path);
export const isUiFile = (path: string) => UI_FILE.test(path) && !isTestFile(path);
export const isNonCodeFile = (path: string) => NON_CODE.test(path);

export interface ProtectedHits {
  paths: Array<{ path: string; globs: string[] }>;
  topics: string[];
}

/**
 * Protected paths and topics a change touches: configured `protectedPaths`, the vision's
 * protected areas, and deploy/release files unless deploys are allowed.
 */
export function protectedHits(input: {
  files: readonly string[];
  /** PR title and body, issue title: searched for protected topics. */
  text: string;
  limits: FactoryLimits;
  areas: ProtectedAreas;
}): ProtectedHits {
  const globs = [
    ...input.limits.protectedPaths,
    ...input.areas.globs,
    ...(input.limits.allowDeploys ? [] : DEPLOY_GLOBS),
  ];
  const paths = input.files
    .map((path) => ({ path, globs: matchingGlobs(path, globs) }))
    .filter((h) => h.globs.length > 0);
  const topics = input.areas.topics.filter((t) => mentionsTopic(input.text, t));
  return { paths, topics };
}

/** A work key slug from a title: `factory:add-dark-mode`. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "item";
}
