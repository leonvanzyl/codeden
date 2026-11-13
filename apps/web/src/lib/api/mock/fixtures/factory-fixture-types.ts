import type {
  AutonomyMode,
  FactoryLimits,
  FactoryLoopState,
  FactoryPrEntry,
  GitHubIssueRef,
  GitHubPrRef,
  PipelineStep,
  WorkKey,
  WorkTrust,
  WorkType,
} from "@codeden/contracts";

/** Compact factory panel fixtures; the mock fills in the full `FactoryStatus` shape. */

export interface FixtureWorkItem {
  id: string;
  title: string;
  workKey: WorkKey;
  issue: GitHubIssueRef | null;
  pr: GitHubPrRef | null;
  score?: number;
  sessionId?: string | null;
  stage:
    | "candidate"
    | "ignored"
    | "backlog"
    | "building"
    | "verifying"
    | "merged"
    | "reverted"
    | "rejected";
  type?: WorkType;
  step?: PipelineStep;
  trust?: WorkTrust;
  author?: string;
  attempts?: number;
}

export type FixtureCheckName =
  | "ci"
  | "tests"
  | "test_results"
  | "review"
  | "security"
  | "ui_evidence"
  | "size";

export interface FixtureChecks {
  prNumber: number;
  title: string;
  checks: {
    name: FixtureCheckName;
    state: "pending" | "pass" | "fail" | "skipped";
    detail?: string;
  }[];
}

export interface FactoryFixture {
  projectId: string;
  mode: AutonomyMode;
  loopState: FactoryLoopState;
  killSwitch: boolean;
  limits: FactoryLimits;
  spendToday: { tokens: number; usd: number };
  mergesToday: number;
  consecutiveFailures: number;
  backlog: FixtureWorkItem[];
  inProgress: FixtureWorkItem[];
  mergeChecks: FixtureChecks[];
  recent: FixtureWorkItem[];
  ignored: FixtureWorkItem[];
  /** The PRs the factory owns, merge queue first (`FactoryStatus.pullRequests`). */
  pullRequests?: FactoryPrEntry[];
  visionExists: boolean;
}
