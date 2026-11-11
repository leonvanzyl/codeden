import type {
  AutonomyMode,
  DiscoveryArea,
  FactoryItemSource,
  FactoryItemStage,
  FactoryLoopState,
  MergeCheckName,
  PipelineStep,
  WorkType,
} from "@codeden/contracts";
import type { Tone } from "@/lib/format";

/** The autonomy ladder (§10.1), climbed one step at a time. */
export const MODES: {
  id: AutonomyMode;
  label: string;
  summary: string;
  finds: string;
  merges: string;
  experimental: boolean;
}[] = [
  {
    id: "manual",
    label: "Manual",
    summary: "You drive every session. Automations only run when you start them.",
    finds: "You",
    merges: "You",
    experimental: false,
  },
  {
    id: "assisted",
    label: "Assisted",
    summary: "You, the PM and automations find work; you review and merge every PR.",
    finds: "You, the PM, automations",
    merges: "You",
    experimental: false,
  },
  {
    id: "software_factory",
    label: "Software factory",
    summary:
      "Issues filed on GitHub by you or trusted people are classified as a bug, feature or docs change and built by a pool of agents. Each ends in a PR with test results and screenshots.",
    finds: "You and trusted authors, on GitHub",
    merges: "You (or CodeDen, with auto-merge)",
    experimental: true,
  },
  {
    id: "dark_factory",
    label: "Dark factory",
    summary:
      "The software factory, plus a scheduled scout that reviews the app against the vision and files the issues itself. You can step away.",
    finds: "The scout, you and trusted authors",
    merges: "You (or CodeDen, with auto-merge)",
    experimental: true,
  },
];

export const MODE_LABEL: Record<AutonomyMode, string> = {
  manual: "Manual",
  assisted: "Assisted",
  software_factory: "Software factory",
  dark_factory: "Dark factory",
};

export const LOOP_LABEL: Record<FactoryLoopState, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "idle" },
  discovering: { label: "Scouting", tone: "running" },
  building: { label: "Building", tone: "running" },
  verifying: { label: "Verifying", tone: "waiting" },
  paused: { label: "Paused", tone: "waiting" },
  stopped: { label: "Stopped", tone: "failed" },
};

export const STAGE_LABEL: Record<FactoryItemStage, { label: string; tone: Tone }> = {
  candidate: { label: "Identifying type", tone: "idle" },
  ignored: { label: "Ignored (untrusted author)", tone: "idle" },
  backlog: { label: "Queued", tone: "idle" },
  building: { label: "Building", tone: "running" },
  verifying: { label: "Verifying", tone: "waiting" },
  watching: { label: "Watching main", tone: "running" },
  merged: { label: "Merged", tone: "done" },
  reverted: { label: "Reverted", tone: "failed" },
  rejected: { label: "Stopped", tone: "idle" },
  failed: { label: "Failed", tone: "failed" },
  escalated: { label: "Needs you", tone: "waiting" },
};

export const SOURCE_LABEL: Record<FactoryItemSource, string> = {
  discovery: "Dark factory scout",
  issue: "GitHub issue",
  failed_check: "Failed check on main",
  revert: "Revert",
};

export const TYPE_LABEL: Record<WorkType, string> = {
  bug: "Bug",
  feature: "Feature",
  docs: "Documentation",
};

export const AREA_LABEL: Record<DiscoveryArea, string> = {
  features: "Features",
  ux: "UI & UX",
  performance: "Performance",
  tech_debt: "Code quality",
  test_gaps: "Test gaps",
  security: "Security",
  bugs: "Bugs",
  docs: "Docs",
};

/** What each step is called in each pipeline (the diagram's node labels). */
export function stepLabel(step: PipelineStep, type: WorkType | null): string {
  switch (step) {
    case "intake":
      return "Identify type";
    case "queued":
      return "Waiting for an agent";
    case "reproduce":
      return "Reproduce";
    case "analyze":
      return "Analyze feature";
    case "implement":
      return type === "bug"
        ? "Create fix"
        : type === "docs"
          ? "Implement docs change"
          : "Implement feature";
    case "review":
      return type === "bug" ? "Review fix" : type === "docs" ? "Checks" : "Review feature";
    case "merge":
      return "Merge";
    case "ignored":
      return "Ignored";
    case "done":
      return "Done";
    case "stopped":
      return "Stopped";
  }
}

export const CHECK_LABEL: Record<MergeCheckName, string> = {
  ci: "CI",
  tests: "Tests",
  test_results: "Test results",
  review: "Review",
  security: "Security",
  ui_evidence: "Screenshots",
  size: "Size",
  protected_paths: "Protected areas",
};

export const CHECK_HELP: Record<MergeCheckName, string> = {
  ci: "The PR's checks passed on GitHub.",
  tests: "Tests changed with the code, or the change needs none.",
  test_results: "The PR reports its test results (a Test results section or attached output).",
  review: "An independent reviewer session approved it (docs-only changes skip it).",
  security: "The audit command and the reviewer found no concerns.",
  ui_evidence: "UI changes have screenshots attached.",
  size: "Small enough for the factory.",
  protected_paths: "Touches no protected area from the vision or the limits.",
};
