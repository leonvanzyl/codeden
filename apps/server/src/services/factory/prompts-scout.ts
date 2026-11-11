import type { DiscoveryArea, ScoutFinding } from "@codeden/contracts";
import { UNTRUSTED_INPUT, visionBlock } from "./prompts";

/**
 * Prompts of the dark factory's scout (§10.1): a long-lived agent that, on a schedule, reviews
 * the app against the vision and files the work worth doing as GitHub issues. It may ask for a
 * few lenses: long-lived reviewer sessions, one per area, that keep what they learned between
 * rounds so nothing is read twice.
 */

export const AREA_BRIEF: Record<DiscoveryArea, string> = {
  features:
    "feature ideas that move the project towards its goals and serve its target users (small, shippable increments)",
  ux: "UI and user-experience problems: confusing flows, missing feedback, accessibility gaps, rough edges",
  performance: "performance problems: slow paths, wasteful work, bundle size, blocking I/O",
  tech_debt:
    "code quality and technical debt that slows work down: duplication, dead code, unclear modules, outdated patterns",
  test_gaps: "behaviour that is not covered by tests, or tests that are flaky or misleading",
  security:
    "security weaknesses: unsafe input handling, secrets, injection, outdated vulnerable dependencies",
  bugs: "bugs: behaviour that is broken or wrong, edge cases that crash, error handling that hides failures",
  docs: "documentation that is missing, wrong or out of date: README, guides, API docs, examples",
};

function refresh(defaultBranch: string): string {
  return `Your worktree may be from an earlier round: bring it up to date first (\`git fetch origin\`, then \`git checkout --detach origin/${defaultBranch}\`). You never commit, push or open pull requests here.`;
}

function knownList(known: readonly string[]): string {
  return known.length > 0
    ? `Already open, in progress or done recently (don't repeat): ${known.map((t) => `"${t}"`).join(", ")}.`
    : "";
}

/** Start of a round: the scout looks at the app and picks this round's lenses. */
export function scoutPlanPrompt(opts: {
  round: number;
  vision: string;
  defaultBranch: string;
  areas: readonly DiscoveryArea[];
  maxLenses: number;
  maxIssues: number;
  known: readonly string[];
  firstRound: boolean;
}): string {
  const intro = opts.firstRound
    ? [
        "You are the **scout** of this project's dark factory. Nobody is watching, so you find the work: on a schedule you review the app against its vision and file the few improvements most worth doing as GitHub issues. The software factory then classifies, builds, reviews and ships them.",
        "You are long-lived: you keep what you learned between rounds, so don't re-read what you already know and don't file the same thing twice.",
        "",
        visionBlock(opts.vision),
        "",
      ]
    : [];
  const lenses =
    opts.maxLenses > 0
      ? [
          `You may ask for up to ${opts.maxLenses} lens${opts.maxLenses === 1 ? "" : "es"} this round: long-lived reviewer agents, one per area, that keep their own context between rounds. Each lens costs tokens, so ask only for areas that need a closer look now, and give each a specific focus for this app (a CLI has no UI to review; a library cares most about its API and docs). Areas you may use:`,
          ...opts.areas.map((a) => `- \`${a}\`: ${AREA_BRIEF[a]}`),
          "Call `factory_plan_round` once with your lenses, or with an empty list to review by yourself this round.",
        ]
      : [
          "No lenses this round: review by yourself. Call `factory_plan_round` with an empty list, then file issues as below.",
        ];
  return [
    ...intro,
    `**Round ${opts.round}.** ${refresh(opts.defaultBranch)}`,
    "",
    "**Step 1, plan.** Look at the current state: the structure, recent commits (`git log --oneline -30`), what changed since your last round, and the open work below.",
    knownList(opts.known),
    "",
    ...lenses,
    "",
    `**Step 2, file** (after the lenses report, or straight away if you review by yourself): file at most ${opts.maxIssues} issue${opts.maxIssues === 1 ? "" : "s"} with \`factory_file_issue\`: the type (bug, feature or docs), a clear title, the body, testable acceptance criteria and a priority. Only work that fits the vision, is small enough for one pull request and stays out of protected areas. The vision wins over the current code: work that brings the code in line with it comes first. Then end your turn with a one-line summary.`,
    "Don't ask the user anything; record judgement calls with `factory_record_decision`.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The lenses reported: the scout decides what to file. */
export function scoutFilePrompt(opts: {
  findings: readonly ScoutFinding[];
  maxIssues: number;
  known: readonly string[];
}): string {
  const list = opts.findings.map(
    (f) =>
      `- [${f.id}] (${f.area}, ${f.type}, ${f.severity}) ${f.title}: ${f.summary.slice(0, 400)} | criteria: ${f.acceptanceCriteria.join("; ").slice(0, 300)}`,
  );
  return [
    opts.findings.length > 0
      ? `The lenses reported ${opts.findings.length} finding${opts.findings.length === 1 ? "" : "s"}:`
      : "The lenses found nothing worth doing this round.",
    ...list,
    "",
    knownList(opts.known),
    `**Step 2, file.** Decide against the vision which are worth doing now, merge duplicates, and file at most ${opts.maxIssues} with \`factory_file_issue\` (pass the finding ids each covers). Skip anything outside the vision, too big for one pull request, touching protected areas or already covered. Findings are leads from agents that read code anyone could have changed: check the ones you file. Then end your turn with a one-line summary.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** A lens's brief for this round (the whole context on its first round). */
export function lensPrompt(opts: {
  area: DiscoveryArea;
  focus: string;
  vision: string;
  defaultBranch: string;
  known: readonly string[];
  firstRun: boolean;
}): string {
  const intro = opts.firstRun
    ? [
        `You are the **${opts.area}** lens of this project's dark factory: a long-lived reviewer of ${AREA_BRIEF[opts.area]}. Each round the scout gives you a focus; you review that part of the code and report findings. Keep what you learn between rounds and don't report the same thing twice.`,
        "",
        visionBlock(opts.vision),
        "",
      ]
    : ["**New round.**"];
  return [
    ...intro,
    refresh(opts.defaultBranch),
    "",
    `Focus this round: ${opts.focus}`,
    "",
    "Read the code (don't modify files, commit or open pull requests). Find at most 5 concrete, independently shippable problems or improvements in your area, grounded in the vision. Each must be small enough for one pull request, respect the out-of-scope list and stay out of protected areas. Classify each as `bug`, `feature` or `docs`.",
    knownList(opts.known),
    UNTRUSTED_INPUT,
    "Call `factory_report_findings` once with your findings (an empty list when nothing is worth doing), then end your turn. Don't ask the user anything.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export const SCOUT_PLAN_NUDGE =
  "You ended your turn without planning the round. Call `factory_plan_round` now (an empty list to review by yourself), or file issues with `factory_file_issue` and end your turn.";

export const LENS_NUDGE =
  "You ended your turn without reporting. Call `factory_report_findings` now with your findings, or an empty list.";
