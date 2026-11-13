import type {
  AutonomyMode,
  DiscoveryArea,
  FactoryItemSource,
  FactoryItemStage,
  FactoryLoopState,
  FactoryPrState,
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

/** A factory PR's state on the panel's merge queue card, with what it means. */
export const PR_STATE_LABEL: Record<FactoryPrState, { label: string; tone: Tone; help: string }> = {
  checking: {
    label: "Checking",
    tone: "running",
    help: "The merge checks are running: the review, tests and evidence.",
  },
  waiting_ci: {
    label: "Waiting for CI",
    tone: "running",
    help: "CI is running, or yet to start, on the newest commit.",
  },
  queued: {
    label: "Queued",
    tone: "waiting",
    help: "Every check passed. The factory merges one pull request at a time, oldest approved first.",
  },
  updating: {
    label: "Updating",
    tone: "running",
    help: "Next to merge, but behind the default branch: GitHub merges the default branch in, then CI runs on the new head. No agent is needed.",
  },
  rebasing: {
    label: "Rebasing",
    tone: "running",
    help: "Merge conflicts with the default branch: the author (or an integrator, when the author's session is gone) rebases it. This isn't a revise round.",
  },
  rebuilding: {
    label: "Rebuilding",
    tone: "running",
    help: "It still conflicted after three requests to rebase, so the work is redone from the default branch. The new pull request replaces this one.",
  },
  superseded: {
    label: "Superseded",
    tone: "idle",
    help: "A newer pull request for the same work replaced this one. The factory closes it with a link to the new one.",
  },
  merged: { label: "Merged", tone: "done", help: "Merged today." },
  waiting_for_you: {
    label: "Waiting for you",
    tone: "waiting",
    help: "A person merges this one (auto-merge is off, a protected area, an untrusted author, or checks that failed). The factory keeps it free of merge conflicts meanwhile.",
  },
  stuck: {
    label: "Stuck",
    tone: "failed",
    help: "The factory can't settle this by itself: it was already rebuilt once, or CI can never run. It is in your inbox.",
  },
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

// ---------------------------------------------------------------- plain-language hints

const LANE_INTRO = "Each issue is sorted into a lane by type, and each lane has its own steps.";

/** What a lane of the pipeline diagram is (the "?" by the lane's name). */
export const LANE_HELP: Record<WorkType, string> = {
  bug: `${LANE_INTRO} Bugs are reproduced first, so the fix is proven against a failing test.`,
  feature: `${LANE_INTRO} Features are analyzed first: does it exist already, and does it fit the vision?`,
  docs: `${LANE_INTRO} Documentation changes go straight to implementation and only need the automated checks.`,
};

/** Where the work comes from (the diagram's first node). */
export function issueHelp(dark: boolean): string {
  return dark
    ? "Work starts as a GitHub issue, filed by the scout, by you or by a trusted author. Issues from anyone else are ignored until you let them in."
    : "Work starts as a GitHub issue filed by you or a trusted author. Issues from anyone else are ignored until you let them in.";
}

/** What happens at a pipeline step and what moves the work on (the diagram's node hints). */
export function stepHelp(step: PipelineStep, type: WorkType | null, autoMerge: boolean): string {
  switch (step) {
    case "intake":
      return "One quick model call reads each new issue and sorts it into the Bug, Feature or Documentation lane (a type label on the issue decides it instead). It then waits for a free agent.";
    case "queued":
      return "Waiting for a free agent. Reviews, revise rounds and rebases of open pull requests get free agents first; then items are picked by priority, then age. At the open pull request limit nothing new starts until one merges, and an item likely to touch the files of an open pull request waits behind items that don't.";
    case "reproduce":
      return "An agent writes a failing test or probe that shows the bug. Once it's reproduced, the same agent moves on to the fix; if it can't be, the work stops and the issue asks for more information.";
    case "analyze":
      return "An agent checks whether the feature exists already and fits the vision, then posts a spec with acceptance criteria on the issue. An accepted spec moves it on to Implement; otherwise the work stops with the reason.";
    case "implement":
      return type === "bug"
        ? "The same agent fixes the bug in its own worktree and opens a pull request with its test results. The pull request moves it on to review."
        : type === "docs"
          ? "An agent makes the documentation change in its own worktree and opens a pull request. The pull request moves it on to the checks."
          : "The same agent builds the feature to the spec in its own worktree and opens a pull request with test results, and screenshots for UI changes. The pull request moves it on to review.";
    case "review":
      return type === "docs"
        ? "The merge checks run on the pull request; a change that touches only documentation skips the agent review. With every check green it moves on to Merge."
        : "A separate reviewer agent checks the pull request while the merge checks run. Approved with every check green, it moves on to Merge; otherwise it goes back to the builder to revise.";
    case "merge":
      return autoMerge
        ? "With every check green, CodeDen merges the pull request itself and watches CI on main; a regression opens a revert and pauses the factory. Work let in from an untrusted author always waits for you."
        : "With every check green, the pull request is ready for you: review it and merge it on GitHub.";
    case "ignored":
      return "Opened by someone who isn't a trusted author, so the factory leaves it alone until you let it in.";
    case "done":
      return "Merged.";
    case "stopped":
      return "The work stopped: not reproduced, declined, failed or closed. You can run it again from its page.";
  }
}

/** The revise loop under each review node. */
export const REVISE_HELP =
  "When the reviewer asks for changes or a merge check fails, the work goes back to the same builder to revise it, a few times at most. The number is how many are being revised now.";

/** The dark factory's scout. */
export const SCOUT_HELP =
  "An agent that periodically reviews the app against your vision and files issues for the work worth doing. It only looks when the queue runs low (the threshold is in Settings), or when you click Run scout now.";

/** One review round of the scout. */
export const ROUND_HELP =
  "One pass of the scout: it plans what to look at, its area reviewers review, then it files the findings most worth doing as issues. A round starts on the schedule you set once the queue runs low, or right away with Run scout now.";

/** "Check now" on the factory panel: one run of the loop's regular check. */
export function checkNowHelp(dark: boolean): string {
  return `Runs the factory's regular check immediately (it runs every 30 seconds): moves work in progress, picks up new issues, starts free agents${dark ? ", and starts the scout if it's due" : ""}.`;
}

/** The work-in-progress limit (`maxOpenPrs`). */
export const WIP_HELP =
  "The work-in-progress limit. With this many factory pull requests open, the factory finishes them before it starts more: no new build starts from the queue, the scout files nothing, and free agents go to reviews, fixes and rebases until one merges or closes. Fixes for failing checks on the default branch still start. Pull requests of failed or escalated work, which wait for you, don't count (work that failed for a reason outside its code goes back by itself, so its pull request does). Fewer open PRs means fewer merge conflicts between them.";

/** Who gets a free agent first. */
export const SLOT_ORDER_HELP =
  "A free agent goes to reviews first (PRs whose CI passed, then rebases and revise rounds, then PRs whose CI still runs), then to builds, and to the scout last. Work in progress is never interrupted.";

/** "Finishing open work (2 of 2 PRs open)". */
export function wipLabel(wip: { openPrs: number; limit: number }): string {
  return `Finishing open work (${wip.openPrs} of ${wip.limit} PRs open)`;
}

/** The scout's review areas (one long-lived reviewer agent per area). */
export const REVIEW_AREAS_HELP =
  "How many focused reviewer agents the scout may use in a round, each looking at one area of the app: security, UI & UX, performance, docs and so on. Each costs tokens; 0 means the scout reviews by itself.";

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
