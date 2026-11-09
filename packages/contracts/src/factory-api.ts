import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, ProviderId, Timestamp } from "./common";
import { AutonomyMode, FactoryLimits, FactoryLoopState } from "./factory";

/**
 * The factory loop of autopilot and dark-factory projects (§10.1): work items, merge checks,
 * the reviewer's verdict, the loop record, the vision and the HTTP shapes of `/api/.../factory`.
 * Autopilot and dark factory are experimental in v1.
 */

/** Modes in which CodeDen finds work and merges automatically. */
export const FACTORY_MODES = ["autopilot", "dark_factory"] as const satisfies AutonomyMode[];

/** True for autopilot and dark factory. */
export function isFactoryMode(mode: AutonomyMode): boolean {
  return (FACTORY_MODES as readonly string[]).includes(mode);
}

/** Areas the improvement finders look at (one discovery session per area). */
export const DiscoveryArea = z.enum([
  "features",
  "ux",
  "performance",
  "tech_debt",
  "test_gaps",
  "security",
]);
export type DiscoveryArea = z.infer<typeof DiscoveryArea>;

/** Where a work item came from. */
export const FactoryItemSource = z.enum(["discovery", "issue", "failed_check", "revert"]);
export type FactoryItemSource = z.infer<typeof FactoryItemSource>;

/**
 * Where a work item is:
 * - `candidate`: found, waiting for the PM to score it against the vision
 * - `backlog`: accepted (a GitHub issue exists), waiting for a build slot
 * - `building`, `verifying` (merge checks), `watching` (merged, main CI watched)
 * - `merged` (done), `reverted`, `rejected` (by the PM), `failed` (merge checks),
 *   `escalated` (needs a human: protected area or a decision)
 */
export const FactoryItemStage = z.enum([
  "candidate",
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

/** The independent reviewer's structured verdict (`factory_submit_review`). */
export const ReviewVerdict = z.object({
  verdict: z.enum(["approve", "request_changes", "reject"]),
  summary: z.string().min(1).max(4_000),
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
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
export type ReviewVerdictInit = z.input<typeof ReviewVerdict>;

/** A work item of the factory loop. */
export const FactoryItem = z.object({
  id: Id,
  projectId: Id,
  /** `factory:<slug>` while a candidate; `issue:<n>` once its issue exists. */
  workKey: z.string().min(1),
  title: z.string().min(1),
  /** Why it matters, as the finder or issue described it. */
  summary: z.string(),
  source: FactoryItemSource,
  area: DiscoveryArea.nullable(),
  acceptanceCriteria: z.array(z.string()),
  /** The PM's score against the vision, 0..1. */
  score: z.number().min(0).max(1).nullable(),
  stage: FactoryItemStage,
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
  /** Last thing the loop noted about it (waiting on a conflict, merge budget, ...). */
  note: z.string().nullable(),
  mergeSha: z.string().nullable(),
  /** For revert items: the item whose merge is reverted. */
  revertOf: Id.nullable(),
  /** When the PM was asked to triage it. */
  triageRequestedAt: Timestamp.nullable(),
  /** Timestamps of nudges sent to the builder or reviewer (keyed by purpose). */
  nudges: z.record(z.string(), Timestamp).default({}),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  mergedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type FactoryItem = z.infer<typeof FactoryItem>;

/** Knobs of the loop beyond the required limits; all have safe defaults. */
export const FactoryTuning = z.object({
  /** Largest change (added + deleted lines) merged automatically. */
  maxChangedLines: z.int().positive().default(800),
  maxChangedFiles: z.int().positive().default(40),
  /** CI must report and pass; a repository without CI cannot auto-merge. */
  requireCi: z.boolean().default(true),
  /** Security/dependency scan run in the builder's worktree (e.g. `pnpm audit --prod`). */
  auditCommand: z.string().min(1).nullable().default(null),
  /** Fix rounds after failed merge checks before an item fails. */
  maxFixAttempts: z.int().nonnegative().default(1),
  /** Dark factory: start discovery when fewer items than this wait to be built. */
  minBacklog: z.int().nonnegative().default(2),
  /** Dark factory: minutes between discovery rounds. */
  discoveryIntervalMin: z.int().positive().default(360),
  /** Discovery sessions per round (round-robin over the areas). */
  discoveryPerRound: z.int().positive().default(2),
  areas: z.array(DiscoveryArea).default(DiscoveryArea.options),
  /** Provider for builders (`auto`: the project/role default). */
  builderProvider: z.union([z.literal("auto"), ProviderId]).default("auto"),
  /** Minutes to wait for main CI after a merge before calling it done. */
  watchTimeoutMin: z.int().positive().default(120),
});
export type FactoryTuning = z.infer<typeof FactoryTuning>;

/** A running improvement-finder session. */
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
  discovery: z.array(DiscoveryRun),
  /** Next area index for round-robin discovery. */
  nextArea: z.int().nonnegative(),
  lastDiscoveryAt: Timestamp.nullable(),
  /** Day of the last daily digest. */
  lastDigestDay: z.string().nullable(),
  /** Issues opened before this are not picked up automatically. */
  enabledAt: Timestamp.nullable(),
  /** Main-branch commits whose failed checks already became items. */
  seenFailedShas: z.array(z.string()).default([]),
  tuning: FactoryTuning.prefault({}),
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
 * `PUT /api/projects/:id/autonomy`. Switching to autopilot or dark factory requires a vision
 * file and limits with a daily budget (sent here, or already saved while in a factory mode).
 */
export const SetAutonomyModeRequest = z.object({
  mode: AutonomyMode,
  limits: FactoryLimits.optional(),
  tuning: FactoryTuning.partial().optional(),
});
export type SetAutonomyModeRequest = z.infer<typeof SetAutonomyModeRequest>;
export type SetAutonomyModeRequestInit = z.input<typeof SetAutonomyModeRequest>;

export const SetAutonomyModeResponse = z.object({
  projectId: Id,
  mode: AutonomyMode,
  limits: FactoryLimits,
  /** Autopilot and dark factory are experimental in v1. */
  experimental: z.boolean(),
});
export type SetAutonomyModeResponse = z.infer<typeof SetAutonomyModeResponse>;

/** `POST /api/projects/:id/kill-switch` and `POST /api/factory/kill-switch`. */
export const KillSwitchRequest = z.object({ on: z.boolean() });
export type KillSwitchRequest = z.infer<typeof KillSwitchRequest>;

export const KillSwitchResponse = z.object({
  on: z.boolean(),
  /** Sessions stopped by turning the switch on. */
  stoppedSessions: z.array(Id),
});
export type KillSwitchResponse = z.infer<typeof KillSwitchResponse>;

/** A work item as the factory panel shows it. */
export const FactoryWorkItem = z.object({
  id: Id,
  title: z.string(),
  workKey: z.string(),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  score: z.number().nullable(),
  sessionId: Id.nullable(),
  stage: FactoryItemStage,
  source: FactoryItemSource,
  reason: z.string().nullable(),
  note: z.string().nullable(),
  updatedAt: Timestamp,
});
export type FactoryWorkItem = z.infer<typeof FactoryWorkItem>;

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
  consecutiveFailures: z.int().nonnegative(),
  activeSessions: z.int().nonnegative(),
  backlog: z.array(FactoryWorkItem),
  inProgress: z.array(FactoryWorkItem),
  mergeChecks: z.array(FactoryMergeChecks),
  /** Merged, reverted, failed, rejected and escalated items, newest first. */
  recent: z.array(FactoryWorkItem),
  visionExists: z.boolean(),
  lastDigest: FactoryDigest.nullable(),
  lastTickAt: Timestamp.nullable(),
});
export type FactoryStatus = z.infer<typeof FactoryStatus>;

/** `GET /api/projects/:id/factory/items/:itemId`. */
export const FactoryItemResponse = z.object({ item: FactoryItem });
export type FactoryItemResponse = z.infer<typeof FactoryItemResponse>;

/** A candidate reported by an improvement finder (`factory_report_candidates`). */
export const FactoryCandidate = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  /** Paths the change would touch, when known. */
  paths: z.array(z.string()).max(50).optional(),
});
export type FactoryCandidate = z.infer<typeof FactoryCandidate>;

/** The PM's decision on a candidate (`factory_triage`). */
export const FactoryTriageRequest = z.object({
  itemId: Id,
  decision: z.enum(["accept", "reject"]),
  /** Score against the vision, 0..1 (accepts). */
  score: z.number().min(0).max(1).optional(),
  /** Replaces the finder's acceptance criteria (accepts). */
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12).optional(),
  /** Why (required for rejects). */
  reason: z.string().trim().min(1).max(1_000).optional(),
});
export type FactoryTriageRequest = z.infer<typeof FactoryTriageRequest>;

// ---------------------------------------------------------------- events

/** Payloads of the factory's persisted events (projected into `factory_*` tables). */
export const FACTORY_EVENT_PAYLOADS = {
  "factory.loop.updated": z.object({ loop: FactoryLoop }),
  "factory.item.updated": z.object({ item: FactoryItem }),
  "factory.digest.created": z.object({ digest: FactoryDigest }),
} as const;
