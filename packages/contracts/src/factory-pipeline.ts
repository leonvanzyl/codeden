import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * The software factory's pipelines (§10.1): every piece of work is classified as a bug, a
 * feature or a docs change and runs through that type's steps:
 *
 * ```
 * Issue -> Identify type -+-> Bug:      Reproduce -> Create fix -> Review fix  -+-> Merge
 *                         +-> Feature:  Analyze   -> Implement  -> Review      -+
 *                         +-> Docs:     Implement docs change -----------------+
 * ```
 *
 * A failed review sends the work back to the builder (the revise loop). Merging is yours unless
 * auto-merge is on. Also the dark factory's scout: its review rounds, lenses and findings.
 */

/** The three pipelines. */
export const WorkType = z.enum(["bug", "feature", "docs"]);
export type WorkType = z.infer<typeof WorkType>;

/** Who decided the type: a GitHub label, the utility model, keywords, the scout or a person. */
export const ClassifiedBy = z.enum([
  "label",
  "model",
  "heuristic",
  "scout",
  "system",
  "user",
  "pm",
]);
export type ClassifiedBy = z.infer<typeof ClassifiedBy>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/** The "Identify type" step's result. */
export const Classification = z.object({
  type: WorkType,
  confidence: Confidence,
  rationale: z.string().max(1_000),
  by: ClassifiedBy,
  at: Timestamp,
});
export type Classification = z.infer<typeof Classification>;

/**
 * Whether the factory may take work on by itself:
 * - `trusted`: an issue by a trusted author (or the account CodeDen uses), or work the factory
 *   found itself (the scout, a failed check on the default branch, a revert);
 * - `untrusted`: an issue by anyone else; it is listed as ignored and nothing runs on it;
 * - `admitted`: an untrusted issue let in by you or by the PM at your request. It runs through
 *   the pipeline but is never merged automatically.
 */
export const WorkTrust = z.enum(["trusted", "untrusted", "admitted"]);
export type WorkTrust = z.infer<typeof WorkTrust>;

/** Outcomes of the first step of the bug (reproduce) and feature (analyze) pipelines. */
export const InvestigationOutcome = z.enum([
  "reproduced",
  "not_reproduced",
  "implement",
  "already_done",
  "needs_info",
  "out_of_scope",
]);
export type InvestigationOutcome = z.infer<typeof InvestigationOutcome>;

/** What the builder found before writing the fix or the feature. */
export const Investigation = z.object({
  kind: z.enum(["reproduction", "analysis"]),
  outcome: InvestigationOutcome,
  summary: z.string().max(2_000),
  /** Reproduction steps, or the spec the feature is built to. */
  details: z.string().max(12_000).nullable(),
  /** The failing test or probe that shows the bug. */
  testPath: z.string().max(500).nullable(),
  at: Timestamp,
});
export type Investigation = z.infer<typeof Investigation>;

/** `factory_report_reproduction`: the bug pipeline's Reproduce step. */
export const FactoryReproductionReport = z.object({
  reproduced: z.boolean(),
  summary: z.string().trim().min(1).max(2_000).describe("What you found, in a few sentences"),
  steps: z
    .string()
    .max(4_000)
    .optional()
    .describe("How to reproduce it: commands or steps, in order"),
  evidence: z
    .string()
    .max(8_000)
    .optional()
    .describe("The failing output, trimmed to what shows the bug"),
  testPath: z
    .string()
    .max(500)
    .optional()
    .describe("The failing test or probe you wrote, relative to the repository root"),
});
export type FactoryReproductionReport = z.infer<typeof FactoryReproductionReport>;

/** `factory_submit_analysis`: the feature pipeline's Analyze step. */
export const FactoryAnalysisReport = z
  .object({
    decision: z.enum(["implement", "already_done", "needs_info", "out_of_scope"]),
    summary: z.string().trim().min(1).max(2_000).describe("Your conclusion, in a few sentences"),
    spec: z
      .string()
      .max(12_000)
      .optional()
      .describe("For `implement`: the spec you will build (API, behaviour, edge cases, docs)"),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(12)
      .optional()
      .describe("For `implement`: testable acceptance criteria"),
  })
  .refine((r) => r.decision !== "implement" || (r.spec && r.acceptanceCriteria), {
    message: "`implement` needs a spec and acceptance criteria",
  });
export type FactoryAnalysisReport = z.infer<typeof FactoryAnalysisReport>;

/**
 * Where a work item is in its pipeline (what the dashboard diagram shows):
 * `intake` (waiting to be classified), `ignored` (untrusted author), `queued` (waiting for a
 * free agent), `reproduce` / `analyze` (first step of bugs and features), `implement` (fix,
 * feature or docs change), `review` (merge checks and the independent review), `merge` (ready
 * for you, merging, or watching the default branch after it), `done`, `stopped`.
 */
export const PipelineStep = z.enum([
  "intake",
  "ignored",
  "queued",
  "reproduce",
  "analyze",
  "implement",
  "review",
  "merge",
  "done",
  "stopped",
]);
export type PipelineStep = z.infer<typeof PipelineStep>;

/** The fields of a work item that decide its step. */
export interface PipelineStepInput {
  stage: string;
  type: WorkType | null;
  investigation: Investigation | null;
  checks: Array<{ state: string }>;
  review: { verdict: string } | null;
}

/** Whether the item's merge checks all passed (none pending or failed). */
export function checksPassed(item: Pick<PipelineStepInput, "checks">): boolean {
  return (
    item.checks.length > 0 && item.checks.every((c) => c.state === "pass" || c.state === "skipped")
  );
}

/** The pipeline step of a work item, from its stage and what it has done so far. */
export function pipelineStep(item: PipelineStepInput): PipelineStep {
  switch (item.stage) {
    case "candidate":
      return "intake";
    case "ignored":
      return "ignored";
    case "backlog":
      return "queued";
    case "building":
      if (!item.investigation && item.type === "bug") return "reproduce";
      if (!item.investigation && item.type === "feature") return "analyze";
      return "implement";
    case "verifying":
      return checksPassed(item) ? "merge" : "review";
    case "watching":
    case "escalated":
      return "merge";
    case "merged":
      return "done";
    default:
      return "stopped";
  }
}

// ---------------------------------------------------------------- the dark factory's scout

/** What the scout's lenses review (one long-lived lens session per area). */
export const DiscoveryArea = z.enum([
  "features",
  "ux",
  "performance",
  "tech_debt",
  "test_gaps",
  "security",
  "bugs",
  "docs",
]);
export type DiscoveryArea = z.infer<typeof DiscoveryArea>;

/** One lens the scout asks for this round (`factory_plan_round`). */
export const ScoutLensRequest = z.object({
  area: DiscoveryArea,
  focus: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe("What this lens should look at this round, specific to this app"),
});
export type ScoutLensRequest = z.infer<typeof ScoutLensRequest>;

/** `factory_plan_round`: the lenses for this round (none: the scout reviews by itself). */
export const FactoryPlanRoundRequest = z.object({
  lenses: z.array(ScoutLensRequest).max(8),
});
export type FactoryPlanRoundRequest = z.infer<typeof FactoryPlanRoundRequest>;

/** One improvement a lens found (`factory_report_findings`). */
export const FactoryFinding = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("What is wrong or missing, and why it matters for the vision"),
  type: WorkType,
  severity: z.enum(["high", "medium", "low"]).default("medium"),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  /** Paths the change would touch, when known. */
  paths: z.array(z.string()).max(50).optional(),
});
export type FactoryFinding = z.infer<typeof FactoryFinding>;
export type FactoryFindingInit = z.input<typeof FactoryFinding>;

/** A finding as the round keeps it, for the scout to decide on. */
export const ScoutFinding = FactoryFinding.extend({
  id: z.string().min(1),
  area: DiscoveryArea,
});
export type ScoutFinding = z.infer<typeof ScoutFinding>;

/** `factory_file_issue`: the scout files one piece of work as a GitHub issue. */
export const FactoryFileIssueRequest = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("The issue body: what and why, grounded in the vision"),
  type: WorkType,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  /** Findings this issue covers. */
  findingIds: z.array(z.string()).max(20).optional(),
});
export type FactoryFileIssueRequest = z.infer<typeof FactoryFileIssueRequest>;
export type FactoryFileIssueRequestInit = z.input<typeof FactoryFileIssueRequest>;

/** One lens of the current round. */
export const ScoutLensRun = z.object({
  area: DiscoveryArea,
  focus: z.string(),
  sessionId: Id,
  sentAt: Timestamp,
  reported: z.boolean(),
  /** When it was reminded to report (once). */
  nudgedAt: Timestamp.nullable().default(null),
});
export type ScoutLensRun = z.infer<typeof ScoutLensRun>;

/**
 * One review round of the scout: `planning` (the scout picks lenses), `reviewing` (the lenses
 * work), `filing` (the scout files the issues worth doing).
 */
export const ScoutRound = z.object({
  id: z.string().min(1),
  phase: z.enum(["planning", "reviewing", "filing"]),
  startedAt: Timestamp,
  /** When the scout was last sent work in this round (its turn must end after this). */
  sentAt: Timestamp,
  nudgedAt: Timestamp.nullable().default(null),
  lenses: z.array(ScoutLensRun).default([]),
  findings: z.array(ScoutFinding).max(60).default([]),
  filed: z.int().nonnegative().default(0),
});
export type ScoutRound = z.infer<typeof ScoutRound>;

/** The scout of a dark factory: its long-lived sessions and the round in progress. */
export const ScoutState = z.object({
  sessionId: Id.nullable().default(null),
  /** One long-lived lens session per area, reused round after round. */
  lensSessions: z.partialRecord(DiscoveryArea, Id).default({}),
  round: ScoutRound.nullable().default(null),
  lastRoundAt: Timestamp.nullable().default(null),
  rounds: z.int().nonnegative().default(0),
});
export type ScoutState = z.infer<typeof ScoutState>;

/** The scout as the dashboard shows it. */
export const ScoutStatus = z.object({
  phase: z.enum(["idle", "planning", "reviewing", "filing"]),
  sessionId: Id.nullable(),
  lenses: z.array(
    z.object({ area: DiscoveryArea, sessionId: Id, reported: z.boolean(), active: z.boolean() }),
  ),
  findings: z.int().nonnegative(),
  filed: z.int().nonnegative(),
  lastRoundAt: Timestamp.nullable(),
  /** When the next round may start (it also waits for the queue to run low). */
  nextRoundAt: Timestamp.nullable(),
  rounds: z.int().nonnegative(),
});
export type ScoutStatus = z.infer<typeof ScoutStatus>;

// ---------------------------------------------------------------- your decisions

/** Let an ignored issue from an untrusted author in (it is never merged automatically). */
export const FactoryAdmitRequest = z.object({
  itemId: Id,
  /** Skip classification with a type you chose. */
  type: WorkType.optional(),
});
export type FactoryAdmitRequest = z.infer<typeof FactoryAdmitRequest>;

/** Correct the type of an item that has not started yet. */
export const FactorySetTypeRequest = z.object({
  itemId: Id,
  type: WorkType,
  reason: z.string().trim().max(500).optional(),
});
export type FactorySetTypeRequest = z.infer<typeof FactorySetTypeRequest>;
