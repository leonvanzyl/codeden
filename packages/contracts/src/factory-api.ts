import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, ProviderId, Timestamp } from "./common";
import { AutonomyMode, FactoryLimits, FactoryLoopState } from "./factory";
import {
  Classification,
  DiscoveryArea,
  Investigation,
  PipelineStep,
  ScoutState,
  ScoutStatus,
  WorkTrust,
  WorkType,
} from "./factory-pipeline";
import { FactoryFailureKind, FactoryPrEntry } from "./factory-prs";

/**
 * The factory loop of software-factory and dark-factory projects (§10.1): work items, merge
 * checks, the reviewer's verdict, the loop record, the vision and the HTTP shapes of
 * `/api/.../factory`. Both modes are experimental. The pipelines themselves are in
 * `factory-pipeline.ts`.
 */

/** Modes in which the factory loop runs. */
export const FACTORY_MODES = ["software_factory", "dark_factory"] as const satisfies AutonomyMode[];

/** True for the software factory and the dark factory. */
export function isFactoryMode(mode: AutonomyMode): boolean {
  return (FACTORY_MODES as readonly string[]).includes(mode);
}

/** Where a work item came from: an issue, the scout, a failed check on main, a revert. */
export const FactoryItemSource = z.enum(["discovery", "issue", "failed_check", "revert"]);
export type FactoryItemSource = z.infer<typeof FactoryItemSource>;

/**
 * Where a work item is in its life (the pipeline step is derived from it, see `pipelineStep`):
 * - `candidate`: received, waiting to be classified (Identify type)
 * - `ignored`: an issue by an untrusted author; nothing runs until someone lets it in
 * - `backlog`: classified, waiting for a free agent
 * - `building` (reproduce or analyze, then implement), `verifying` (merge checks, the review,
 *   then ready to merge), `watching` (merged automatically, main CI watched)
 * - `merged` (done), `reverted`, `rejected` (not reproduced, declined, closed), `failed`
 *   (merge checks), `escalated` (touches a protected area: yours to merge)
 */
export const FactoryItemStage = z.enum([
  "candidate",
  "ignored",
  "backlog",
  "building",
  "verifying",
  "watching",
  "merged",
  "reverted",
  "rejected",
  "failed",
  "escalated",
]);
export type FactoryItemStage = z.infer<typeof FactoryItemStage>;

/** The merge checks; all must pass before an automatic merge. */
export const MergeCheckName = z.enum([
  "ci",
  "tests",
  "test_results",
  "review",
  "security",
  "ui_evidence",
  "size",
  "protected_paths",
]);
export type MergeCheckName = z.infer<typeof MergeCheckName>;

export const MergeCheckState = z.enum(["pending", "pass", "fail", "skipped"]);
export type MergeCheckState = z.infer<typeof MergeCheckState>;

/** One recorded merge-check result. */
export const MergeCheck = z.object({
  name: MergeCheckName,
  state: MergeCheckState,
  detail: z.string().nullable(),
  /** A failure that needs a human (protected area) rather than a fix. */
  escalate: z.boolean().default(false),
  at: Timestamp,
});
export type MergeCheck = z.infer<typeof MergeCheck>;

/** Longest review summary stored with a verdict; a longer one is stored truncated. */
export const REVIEW_SUMMARY_MAX = 20_000;

/** Ends a review summary that was cut to `REVIEW_SUMMARY_MAX`. */
export const REVIEW_SUMMARY_TRUNCATED = "… (truncated)";

/**
 * A review summary as stored: unchanged up to `REVIEW_SUMMARY_MAX` characters, otherwise cut
 * to fit and ended with `REVIEW_SUMMARY_TRUNCATED`. A verdict is never lost over its length.
 */
export function truncateReviewSummary(summary: string): string {
  if (summary.length <= REVIEW_SUMMARY_MAX) return summary;
  let kept = summary.slice(0, REVIEW_SUMMARY_MAX - REVIEW_SUMMARY_TRUNCATED.length - 1);
  // Don't leave half of a surrogate pair (an emoji) at the cut.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept.trimEnd()} ${REVIEW_SUMMARY_TRUNCATED}`;
}

/** The independent reviewer's structured verdict (`factory_submit_review`), as stored. */
export const ReviewVerdict = z.object({
  verdict: z.enum(["approve", "request_changes", "reject"]),
  summary: z.string().min(1).max(REVIEW_SUMMARY_MAX),
  /** One entry per acceptance criterion. */
  criteria: z
    .array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string().optional() }))
    .default([]),
  vision: z.object({ aligned: z.boolean(), note: z.string().optional() }),
  tests: z.object({
    adequate: z.boolean(),
    /** True when the change needs no tests (docs, config, copy). */
    notNeeded: z.boolean().optional(),
    note: z.string().optional(),
  }),
  security: z.object({ concerns: z.array(z.string()).default([]) }),
  /**
   * What stops an approval, with `request_changes`. `pr` (the default, when absent): something
   * wrong with the pull request (a defect, a missing criterion, red CI). `environment`: only the
   * reviewer's own local environment (missing or corrupted dependencies, timeouts under load)
   * couldn't verify the change. Then CI on the PR's head is the authority for the full suite: the
   * factory never sends the verdict to the author as a revise round.
   */
  blockers: z
    .enum(["pr", "environment"])
    .optional()
    .describe(
      "With `request_changes`: `pr` (default) when something is wrong with the pull request; `environment` when only your local environment couldn't verify it (broken dependencies, timeouts). CI on the PR's head is the authority for the full suite, so an `environment` verdict isn't sent to the author: you get the CI result instead.",
    ),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
export type ReviewVerdictInit = z.input<typeof ReviewVerdict>;

/**
 * What a reviewer sends to `factory_submit_review`: a `ReviewVerdict` whose summary has no
 * upper bound, so a long review is never rejected; the tool stores it with
 * `truncateReviewSummary`.
 */
export const ReviewVerdictSubmission = ReviewVerdict.extend({
  summary: z
    .string()
    .min(1)
    .describe(
      `What you found, specifically. Up to ${REVIEW_SUMMARY_MAX.toLocaleString("en-US")} characters are stored; anything longer is cut and marked "${REVIEW_SUMMARY_TRUNCATED}".`,
    ),
});
export type ReviewVerdictSubmission = z.infer<typeof ReviewVerdictSubmission>;

/** A work item of the factory loop. */
export const FactoryItem = z.object({
  id: Id,
  projectId: Id,
  /** `issue:<n>` once its issue exists (`factory:<slug>` before). */
  workKey: z.string().min(1),
  title: z.string().min(1),
  /** The issue body, or why it matters as the scout described it. */
  summary: z.string(),
  source: FactoryItemSource,
  area: DiscoveryArea.nullable(),
  acceptanceCriteria: z.array(z.string()),
  /** Priority, 0..1 (higher first); null for issues, which queue in order of arrival. */
  score: z.number().min(0).max(1).nullable(),
  stage: FactoryItemStage,
  /** The pipeline (bug, feature, docs); null until classified. */
  type: WorkType.nullable().default(null),
  classification: Classification.nullable().default(null),
  /** Whether the factory may act on it by itself (see `WorkTrust`). */
  trust: WorkTrust.default("trusted"),
  /** GitHub login of the issue's author, when it came from an issue. */
  author: z.string().nullable().default(null),
  /** Who let an untrusted issue in. */
  admittedBy: z.enum(["user", "pm"]).nullable().default(null),
  /** The bug's reproduction or the feature's analysis, once the builder reported it. */
  investigation: Investigation.nullable().default(null),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  builderSessionId: Id.nullable(),
  builderProvider: ProviderId.nullable(),
  reviewerSessionId: Id.nullable(),
  reviewerProvider: ProviderId.nullable(),
  /** Set when the reviewer had to run on the author's provider. */
  reviewerNote: z.string().nullable(),
  review: ReviewVerdict.nullable(),
  checks: z.array(MergeCheck),
  /** Fix rounds after failed merge checks. */
  attempts: z.int().nonnegative(),
  /** Why it was rejected, failed or escalated. */
  reason: z.string().nullable(),
  /** Why it failed or was escalated: its own work, the infrastructure, or stuck until a person looks (see `FactoryFailureKind`). */
  failureKind: FactoryFailureKind.nullable().default(null),
  /**
   * The pull request a rebuild replaced: after three requests to rebase it still conflicted, so
   * the work was redone from the default branch and that PR is closed once the new one opens.
   * Set means the item's one rebuild is used.
   */
  rebuiltFrom: GitHubPrRef.nullable().default(null),
  /** Last thing the loop noted about it (waiting on a conflict, merge budget, ...). */
  note: z.string().nullable(),
  mergeSha: z.string().nullable(),
  /** For revert items: the item whose merge is reverted. */
  revertOf: Id.nullable(),
  /** When the PM was asked to triage it. */
  triageRequestedAt: Timestamp.nullable(),
  /** Timestamps of nudges sent to the builder or reviewer (keyed by purpose). */
  nudges: z.record(z.string(), Timestamp).default({}),
  /**
   * Why the PM let this item go over the size limit (an initial scaffold, a stack migration:
   * work that can't be split). The size check then passes; every other check still applies.
   */
  largeChange: z.string().nullable().default(null),
  /**
   * When the factory archived the item's builder and reviewer sessions after it finished, which
   * removes their worktrees (the branch and transcript stay); null until then. Set once, so a
   * session someone unarchives stays unarchived. Retry clears it.
   */
  sessionsArchivedAt: Timestamp.nullable().default(null),
  /**
   * Sessions of attempts before a retry that weren't archived yet. The factory archives them
   * once none of them is busy (a turn is never cut off), then empties the list.
   */
  earlierSessionIds: z.array(Id).default([]),
  /**
   * When the item entered its current pipeline step (`pipelineStep`), for "how long has it been
   * here" on the Factory view. Set on creation and whenever the step changes; null on items
   * saved before it existed (readers fall back to `updatedAt`).
   */
  stepSince: Timestamp.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  mergedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type FactoryItem = z.infer<typeof FactoryItem>;

/** Size limit defaults before 0.4.4, upgraded to the current defaults when a loop is read. */
export const LEGACY_SIZE_LIMITS = { maxChangedLines: 800, maxChangedFiles: 40 } as const;

/**
 * What a review does when the provider chosen for it is unavailable (not installed, not signed
 * in, at its usage limit, or it just failed to run):
 * - `builder`: review on the builder's provider and model, in a fresh session;
 * - `any`: review on any available provider;
 * - `wait`: wait until the chosen provider is available again.
 * With no provider available at all, every choice waits.
 */
export const ReviewerFallback = z.enum(["builder", "any", "wait"]);
export type ReviewerFallback = z.infer<typeof ReviewerFallback>;

/** Knobs of the loop beyond the required limits; all have safe defaults. */
export const FactoryTuning = z.object({
  /**
   * Largest change merged automatically: added + deleted lines, not counting lockfiles and
   * generated or vendored files. `null`: no limit.
   */
  maxChangedLines: z.int().positive().nullable().default(5_000),
  /** Most files changed (same files not counted). `null` (the default): no limit. */
  maxChangedFiles: z.int().positive().nullable().default(null),
  /** CI must report and pass; a repository without CI cannot auto-merge. */
  requireCi: z.boolean().default(true),
  /** Security/dependency scan run in the builder's worktree (e.g. `pnpm audit --prod`). */
  auditCommand: z.string().min(1).nullable().default(null),
  /** Revise rounds (failed review or merge checks) before an item fails. */
  maxFixAttempts: z.int().nonnegative().default(2),
  /**
   * Dark factory: the scout starts a scheduled round only when fewer items than this wait to be
   * classified or for an agent. 0 turns scheduled rounds off: only "Run scout now" starts one.
   */
  minBacklog: z.int().nonnegative().default(2),
  /** Dark factory: minutes between the scout's review rounds. */
  discoveryIntervalMin: z.int().positive().default(360),
  /**
   * Dark factory: most review areas the scout may use per round, each with its own long-lived
   * area reviewer session ("Review areas per round" in the UI).
   */
  discoveryPerRound: z.int().nonnegative().default(2),
  /** Dark factory: most issues the scout may file per round. */
  maxIssuesPerRound: z.int().positive().default(3),
  /** Dark factory: the review areas the scout may use. */
  areas: z.array(DiscoveryArea).default(DiscoveryArea.options),
  /**
   * Provider for builders (`auto`: the project/role default). One that isn't available (not
   * installed, not signed in, at its usage limit) is skipped for another available provider.
   */
  builderProvider: z.union([z.literal("auto"), ProviderId]).default("auto"),
  /** Model for builders on `builderProvider`; `null` (the default): that provider's default. */
  builderModel: z.string().min(1).nullable().default(null),
  /**
   * Provider for the independent reviewer. `auto` (the default): a provider other than the
   * builder's when one is available, which gives the most independent review.
   */
  reviewerProvider: z.union([z.literal("auto"), ProviderId]).default("auto"),
  /** Model for reviewers on `reviewerProvider`; `null` (the default): that provider's default. */
  reviewerModel: z.string().min(1).nullable().default(null),
  /** What a review does when its chosen provider isn't available (see `ReviewerFallback`). */
  reviewerFallback: ReviewerFallback.default("builder"),
  /** Minutes to wait for main CI after a merge before calling it done. */
  watchTimeoutMin: z.int().positive().default(120),
  /**
   * Minutes a builder or reviewer may stay idle, after it was reminded of its step (report,
   * pull request or verdict) and ended its turn again, before the item fails. An agent waiting
   * on its own background command ends its turn and is woken when the command exits, so a turn
   * end alone doesn't mean it stopped working.
   */
  idleGraceMin: z.int().positive().default(10),
});
export type FactoryTuning = z.infer<typeof FactoryTuning>;

/**
 * A change to some tuning knobs. Unlike `FactoryTuning.partial()`, absent fields stay absent
 * (no defaults filled in), so saving one knob never resets the others.
 */
export const FactoryTuningPatch = z.object(
  Object.fromEntries(
    Object.entries(FactoryTuning.shape).map(([key, schema]) => {
      const kind = (schema as z.ZodType)._zod.def.type;
      const inner =
        kind === "default" || kind === "prefault"
          ? (schema as unknown as { unwrap(): z.ZodType }).unwrap()
          : (schema as z.ZodType);
      return [key, inner.optional()];
    }),
  ) as unknown as { [K in keyof FactoryTuning]: z.ZodOptional<z.ZodType<FactoryTuning[K]>> },
);
export type FactoryTuningPatch = z.infer<typeof FactoryTuningPatch>;

/** A discovery session of loops before 0.6 (kept so old loops still parse). */
export const DiscoveryRun = z.object({ sessionId: Id, area: DiscoveryArea, startedAt: Timestamp });
export type DiscoveryRun = z.infer<typeof DiscoveryRun>;

/** The persisted loop of one project; resumable after a restart. */
export const FactoryLoop = z.object({
  projectId: Id,
  state: FactoryLoopState,
  pausedReason: z.string().nullable(),
  consecutiveFailures: z.int().nonnegative(),
  /** Local day (`YYYY-MM-DD`) the counters below belong to. */
  day: z.string(),
  mergesToday: z.int().nonnegative(),
  /** Unused since 0.6 (the scout replaced the discovery sessions). */
  discovery: z.array(DiscoveryRun).default([]),
  /** Unused since 0.6. */
  nextArea: z.int().nonnegative().default(0),
  /** Unused since 0.6 (see `scout.lastRoundAt`). */
  lastDiscoveryAt: Timestamp.nullable().default(null),
  /** The dark factory's scout. */
  scout: ScoutState.prefault({}),
  /** Day of the last daily digest. */
  lastDigestDay: z.string().nullable(),
  /** Issues opened before this are not picked up automatically. */
  enabledAt: Timestamp.nullable(),
  /** Main-branch commits whose failed checks already became items. */
  seenFailedShas: z.array(z.string()).default([]),
  tuning: FactoryTuning.prefault({}),
  /**
   * The last tick that changed the loop. A tick that changes nothing else saves nothing, so
   * this can be older than the last tick (`FactoryStatus.lastTickAt` has that).
   */
  lastTickAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type FactoryLoop = z.infer<typeof FactoryLoop>;

/** The daily digest (inbox item + notice to the orchestrator). */
export const FactoryDigest = z.object({
  id: Id,
  projectId: Id,
  day: z.string(),
  shipped: z.array(
    z.object({ itemId: Id, title: z.string(), pr: GitHubPrRef.nullable(), reverted: z.boolean() }),
  ),
  rejected: z.array(
    z.object({ itemId: Id, title: z.string(), stage: FactoryItemStage, reason: z.string() }),
  ),
  spend: z.object({
    usd: z.number().nonnegative(),
    tokens: z.int().nonnegative(),
    budgetUsd: z.number().nullable(),
    budgetTokens: z.int().nullable(),
  }),
  waiting: z.array(
    z.object({ title: z.string(), inboxItemId: Id.nullable(), itemId: Id.nullable() }),
  ),
  /** Judgement calls factory agents made on their own during the day (dark factory). */
  decisions: z
    .array(
      z.object({
        title: z.string(),
        decision: z.string(),
        needsHuman: z.boolean(),
        inboxItemId: Id,
      }),
    )
    .default([]),
  text: z.string(),
  createdAt: Timestamp,
});
export type FactoryDigest = z.infer<typeof FactoryDigest>;

/**
 * `factory_record_decision` (§10.1): in a dark factory nobody is watching, so a factory agent
 * that would have asked the user decides from the vision instead and records the call here.
 * It reaches the user's inbox and the daily digest so they can review or override it later;
 * nothing waits on it. `needsHuman` flags the few calls that are the user's to make
 * (protected areas, a missing or self-contradicting vision, anything irreversible outside the
 * code) without stopping the loop.
 */
export const FactoryDecisionRequest = z.object({
  /** What the agent would have asked. */
  question: z.string().min(1).max(2_000),
  /** What it decided. */
  decision: z.string().min(1).max(2_000),
  /** Why, grounded in the vision. */
  reasoning: z.string().min(1).max(4_000),
  needsHuman: z.boolean().default(false),
});
export type FactoryDecisionRequest = z.infer<typeof FactoryDecisionRequest>;

// ---------------------------------------------------------------- vision

/** Protected areas parsed from the vision: path globs and topics that always need a human. */
export const ProtectedAreas = z.object({
  globs: z.array(z.string()),
  topics: z.array(z.string()),
});
export type ProtectedAreas = z.infer<typeof ProtectedAreas>;

export const ParsedVision = z.object({
  goals: z.array(z.string()),
  users: z.array(z.string()),
  principles: z.array(z.string()),
  outOfScope: z.array(z.string()),
  qualityBar: z.array(z.string()),
  protectedAreas: ProtectedAreas,
});
export type ParsedVision = z.infer<typeof ParsedVision>;

/** `GET /api/projects/:id/vision`: the template when the file does not exist yet. */
export const VisionResponse = z.object({
  path: z.string(),
  exists: z.boolean(),
  contents: z.string(),
  parsed: ParsedVision,
  /**
   * After a save in a GitHub project: the pull request (`codeden/vision`) that commits the
   * vision, so agents' worktrees (cut from the default branch) get it once it merges.
   */
  pr: GitHubPrRef.nullable().optional(),
  /** Why the vision could not be committed to GitHub (it is still saved locally). */
  shareError: z.string().nullable().optional(),
});
export type VisionResponse = z.infer<typeof VisionResponse>;

/** `PUT /api/projects/:id/vision`. */
export const PutVisionRequest = z.object({ contents: z.string().min(1).max(200_000) });
export type PutVisionRequest = z.infer<typeof PutVisionRequest>;

// ---------------------------------------------------------------- HTTP shapes

/**
 * `PUT /api/projects/:id/autonomy`. Switching to the software or dark factory requires a GitHub
 * project, a vision file and limits with a daily budget (sent here, or already saved while in
 * a factory mode).
 */
export const SetAutonomyModeRequest = z.object({
  mode: AutonomyMode,
  limits: FactoryLimits.optional(),
  tuning: FactoryTuningPatch.optional(),
});
export type SetAutonomyModeRequest = z.infer<typeof SetAutonomyModeRequest>;
/** What a client sends; `mode` is typed as today's ids (the schema also reads the old one). */
export type SetAutonomyModeRequestInit = Omit<z.input<typeof SetAutonomyModeRequest>, "mode"> & {
  mode: AutonomyMode;
};

export const SetAutonomyModeResponse = z.object({
  projectId: Id,
  mode: AutonomyMode,
  limits: FactoryLimits,
  /** The software and dark factory are experimental. */
  experimental: z.boolean(),
});
export type SetAutonomyModeResponse = z.infer<typeof SetAutonomyModeResponse>;

/**
 * Error code of `POST /api/projects/:id/factory/scout` ("Run scout now", → `FactoryStatus`)
 * when no round can start right now (409): not a dark factory, a kill switch is on, the loop is
 * paused, a round is running or no agent slot is free. The message says which, as
 * `ScoutStatus.runNowBlockedBy` does.
 */
export const SCOUT_UNAVAILABLE = "scout_unavailable";

/** `POST /api/projects/:id/kill-switch` and `POST /api/factory/kill-switch`. */
export const KillSwitchRequest = z.object({ on: z.boolean() });
export type KillSwitchRequest = z.infer<typeof KillSwitchRequest>;

export const KillSwitchResponse = z.object({
  on: z.boolean(),
  /** Sessions stopped by turning the switch on. */
  stoppedSessions: z.array(Id),
});
export type KillSwitchResponse = z.infer<typeof KillSwitchResponse>;

/** A work item as the factory panel and its pipeline diagram show it. */
export const FactoryWorkItem = z.object({
  id: Id,
  title: z.string(),
  workKey: z.string(),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  score: z.number().nullable(),
  /** The builder session. */
  sessionId: Id.nullable(),
  /** The independent reviewer's session, once there is one. */
  reviewerSessionId: Id.nullable().default(null),
  /** The session working on it right now (the reviewer while reviewing), for the diagram. */
  activeSessionId: Id.nullable().default(null),
  stage: FactoryItemStage,
  step: PipelineStep.default("intake"),
  type: WorkType.nullable().default(null),
  trust: WorkTrust.default("trusted"),
  author: z.string().nullable().default(null),
  source: FactoryItemSource,
  /** Revise rounds so far. */
  attempts: z.int().nonnegative().default(0),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  /** Why it failed, for items that did (see `FactoryFailureKind`). */
  failureKind: FactoryFailureKind.nullable().default(null),
  /** When it entered its current pipeline step; null when unknown (use `updatedAt`). */
  stepSince: Timestamp.nullable().default(null),
  mergedAt: Timestamp.nullable().default(null),
  finishedAt: Timestamp.nullable().default(null),
  /**
   * The open pull request the factory still owns for it: its own, or, while a rebuild has no PR
   * of its own yet (or failed without one), the PR the rebuild replaces. Null when it owns none.
   * Unlike `FactoryStatus.pullRequests`, never cut short.
   */
  ownedPr: GitHubPrRef.nullable().default(null),
  /**
   * Its merge checks so far: passed (passed or skipped), failed and all recorded; null before
   * any ran.
   */
  checks: z
    .object({
      passed: z.int().nonnegative(),
      failed: z.int().nonnegative(),
      total: z.int().nonnegative(),
    })
    .nullable()
    .default(null),
  updatedAt: Timestamp,
});
export type FactoryWorkItem = z.infer<typeof FactoryWorkItem>;

/**
 * Throughput figures of the Factory view's stats strip, counted over the project's items by the
 * server's local day (the same day the merge counter and the budget use).
 */
export const FactoryStats = z.object({
  /** Factory items merged today, by CodeDen or by a person on GitHub. */
  mergedToday: z.int().nonnegative().default(0),
  /** Items that failed today. */
  failedToday: z.int().nonnegative().default(0),
  /** Items whose merge was reverted today. */
  revertedToday: z.int().nonnegative().default(0),
  /**
   * Median time from the factory taking the issue in (`createdAt`) to its merge, over the items
   * merged in the last 7 days, in milliseconds; null when none merged.
   */
  medianMergeMs7d: z.number().nonnegative().nullable().default(null),
  /** How many merges the median is over. */
  merged7d: z.int().nonnegative().default(0),
});
export type FactoryStats = z.infer<typeof FactoryStats>;

/** Merge-check results of one item with a PR. */
export const FactoryMergeChecks = z.object({
  itemId: Id,
  prNumber: z.int().positive(),
  title: z.string(),
  checks: z.array(MergeCheck),
  reviewerProvider: ProviderId.nullable(),
  reviewerNote: z.string().nullable(),
  verdict: ReviewVerdict.shape.verdict.nullable(),
});
export type FactoryMergeChecks = z.infer<typeof FactoryMergeChecks>;

/** `GET /api/projects/:id/factory`: everything the factory panel shows. */
export const FactoryStatus = z.object({
  projectId: Id,
  mode: AutonomyMode,
  experimental: z.boolean(),
  loopState: FactoryLoopState,
  pausedReason: z.string().nullable(),
  /** The project's switch; `globalKillSwitch` stops every project. */
  killSwitch: z.boolean(),
  globalKillSwitch: z.boolean(),
  limits: FactoryLimits,
  tuning: FactoryTuning,
  spendToday: z.object({ tokens: z.int().nonnegative(), usd: z.number().nonnegative() }),
  mergesToday: z.int().nonnegative(),
  /** Today's merges, failures and reverts and the 7-day median time to merge. */
  stats: FactoryStats.prefault({}),
  consecutiveFailures: z.int().nonnegative(),
  activeSessions: z.int().nonnegative(),
  /** Waiting: being classified (`candidate`) or for a free agent (`backlog`). */
  backlog: z.array(FactoryWorkItem),
  inProgress: z.array(FactoryWorkItem),
  mergeChecks: z.array(FactoryMergeChecks),
  /**
   * The pull requests the factory owns: the merge queue first, in the order they merge, then
   * the rest (being checked, rebased, rebuilt, waiting for you) and today's merges.
   */
  pullRequests: z.array(FactoryPrEntry).default([]),
  /** Merged, reverted, failed, rejected and escalated items, newest first (the latest 30). */
  recent: z.array(FactoryWorkItem),
  /**
   * Finished items the Factory view keeps showing, however many newer results `recent` holds:
   * every escalated item, failed items that failed in the last 24 hours or still own an open
   * pull request, and items merged today.
   */
  viewRecent: z.array(FactoryWorkItem).default([]),
  /** Issues by untrusted authors, newest first; nothing runs on them until let in. */
  ignored: z.array(FactoryWorkItem).default([]),
  /** The account CodeDen uses on GitHub (always trusted); null when unknown. */
  githubLogin: z.string().nullable().default(null),
  /** The dark factory's scout; null in the software factory. */
  scout: ScoutStatus.nullable().default(null),
  visionExists: z.boolean(),
  lastDigest: FactoryDigest.nullable(),
  /**
   * When the loop last ticked (the panel's "last check"), changed or not. After a server
   * restart, the last tick that changed the loop until the first tick runs.
   */
  lastTickAt: Timestamp.nullable(),
});
export type FactoryStatus = z.infer<typeof FactoryStatus>;

/** `GET /api/projects/:id/factory/items/:itemId`. */
export const FactoryItemResponse = z.object({ item: FactoryItem });
export type FactoryItemResponse = z.infer<typeof FactoryItemResponse>;

/**
 * `factory_allow_large_change`: the PM lets an item that failed only the size check merge
 * after all, because the work can't be split. The item goes back to verifying.
 */
export const FactoryAllowLargeChangeRequest = z.object({
  itemId: Id,
  reason: z.string().trim().min(1).max(500),
});
export type FactoryAllowLargeChangeRequest = z.infer<typeof FactoryAllowLargeChangeRequest>;

// ---------------------------------------------------------------- events

/** Payloads of the factory's persisted events (projected into `factory_*` tables). */
export const FACTORY_EVENT_PAYLOADS = {
  "factory.loop.updated": z.object({ loop: FactoryLoop }),
  "factory.item.updated": z.object({ item: FactoryItem }),
  "factory.digest.created": z.object({ digest: FactoryDigest }),
} as const;
