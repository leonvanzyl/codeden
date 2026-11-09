import type { DiscoveryArea, FactoryItem, MergeCheck } from "@codeden/contracts";

/**
 * Prompts of the factory loop (§10.1): improvement finders, builders, independent reviewers,
 * the PM's triage instructions and the follow-ups the loop sends. The server enforces limits;
 * these prompts only carry the judgement work.
 */

const AREA_BRIEF: Record<DiscoveryArea, string> = {
  features:
    "feature ideas that move the project towards its goals and serve its target users (small, shippable increments)",
  ux: "user-experience problems: confusing flows, missing feedback, accessibility gaps, rough edges",
  performance: "performance problems: slow paths, wasteful work, bundle size, blocking I/O",
  tech_debt:
    "technical debt that slows work down: duplication, dead code, unclear modules, outdated patterns",
  test_gaps: "behaviour that is not covered by tests, or tests that are flaky or misleading",
  security:
    "security weaknesses: unsafe input handling, secrets, injection, outdated vulnerable dependencies",
};

function visionBlock(vision: string): string {
  return ["<vision>", vision.trim(), "</vision>"].join("\n");
}

function criteriaList(item: FactoryItem): string {
  return item.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/** An improvement finder for one area. */
export function discoveryPrompt(opts: {
  area: DiscoveryArea;
  vision: string;
  known: string[];
}): string {
  return [
    `You are an improvement finder for this repository's factory loop. Area: **${opts.area}** — ${AREA_BRIEF[opts.area]}.`,
    "",
    "Read the code (do not modify any files, do not commit, do not open pull requests). Find at most 3 concrete, independently shippable improvements in this area that are grounded in the vision below. Each must be small enough for one pull request, must respect the out-of-scope list and must not touch protected areas.",
    "",
    visionBlock(opts.vision),
    "",
    opts.known.length > 0
      ? `Already known (do not repeat): ${opts.known.map((t) => `"${t}"`).join(", ")}.`
      : "",
    "Don't ask the user anything: when you're unsure about a candidate, state your assumption in its summary or leave it out. If the code doesn't match the vision (a different stack or architecture, say), the work that brings it in line is a candidate in its own right.",
    "When done, call `factory_report_candidates` once with your candidates (title, summary of why it matters, testable acceptance criteria, paths it would touch). If you found nothing worth doing, call it with an empty list. Then call `finish` with a one-line summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The builder of one accepted item. */
export function builderPrompt(item: FactoryItem, vision: string): string {
  const issue = item.issue ? `GitHub issue #${item.issue.number} (${item.issue.url})` : "the item";
  return [
    `Implement ${issue}: **${item.title}**`,
    "",
    item.summary,
    "",
    "Acceptance criteria:",
    criteriaList(item),
    "",
    visionBlock(vision),
    "",
    "How to work:",
    "- Work only in this worktree. Keep the change small and focused on the criteria; stay out of protected areas and never deploy or release anything.",
    "- Add or update tests that prove every criterion, and run the project's tests and linters until they pass.",
    "- Don't stop to ask the user: make the reasonable call within the criteria and the vision, and say what you assumed in the pull request description. If you truly cannot go on, call `finish` with outcome `blocked`.",
    "- Commit, then open the pull request with `create_pull_request` (it links the issue with `Fixes #N`).",
    "- If you changed anything visible in a UI, start the dev server, take browser screenshots of the change and attach them with `attach_evidence`.",
    "- Call `finish` with the outcome, a summary, the tests you ran and the changed files.",
    "An independent reviewer on another provider checks your pull request against the criteria and the vision before CodeDen merges it automatically.",
  ].join("\n");
}

/** The independent reviewer of one pull request. */
export function reviewerPrompt(
  item: FactoryItem,
  vision: string,
  note: string | null,
  /** Base branch when the reviewer runs in the author's worktree (the change is local). */
  localBase: string | null,
): string {
  const pr = item.pr ? `#${item.pr.number} (${item.pr.url})` : "the pull request";
  const read = localBase
    ? `You are in the author's worktree, on the PR branch. Read the change locally and offline: \`git diff ${localBase}...HEAD\`, \`git log --oneline ${localBase}..HEAD\`, and the code around it; run the tests if useful. Do not use the network (no \`gh\`, no fetch). Do not modify files, commit or push.`
    : `Read the change (for example \`gh pr diff ${item.pr?.number ?? ""}\` and \`gh pr view ${item.pr?.number ?? ""}\`), and the code around it. Do not modify files, commit, push or comment on GitHub.`;
  return [
    `You are the independent reviewer of pull request ${pr}: **${item.title}**. Another agent wrote it; CodeDen merges it automatically only if you approve and every other merge check passes.`,
    note ? `Note: ${note}` : "",
    "",
    "Acceptance criteria:",
    criteriaList(item),
    "",
    visionBlock(vision),
    "",
    read,
    "Judge: does it meet every criterion? Does it fit the vision and stay out of its out-of-scope list and protected areas? Are there tests that prove the behaviour (or are none needed)? Any security problems (injection, secrets, unsafe input, risky dependencies)?",
    "",
    "Then call `factory_submit_review` exactly once with your verdict: `approve` only when everything holds, `request_changes` for fixable problems, `reject` when the change should not exist. Be specific in the summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Message to the builder after failed merge checks. */
export function fixPrompt(item: FactoryItem, failed: MergeCheck[]): string {
  return [
    `The merge checks for your pull request${item.pr ? ` #${item.pr.number}` : ""} failed:`,
    ...failed.map((c) => `- ${c.name}: ${c.detail ?? "failed"}`),
    item.review && item.review.verdict !== "approve" ? `Reviewer: ${item.review.summary}` : "",
    "",
    "Fix these in the same branch, run the tests, commit and push (call `create_pull_request` again to update the PR), then call `finish`.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Ask a reviewer to look again after fixes. */
export function reReviewPrompt(item: FactoryItem): string {
  return `The author pushed fixes to pull request #${item.pr?.number ?? "?"}. Review the updated change again against the same criteria and call \`factory_submit_review\` once with a fresh verdict.`;
}

export const BUILDER_NUDGE =
  "You ended your turn without an open pull request. If the work is done, commit it and call `create_pull_request`; if you are blocked, call `finish` with outcome `blocked` and explain why.";

export const REVIEWER_NUDGE =
  "You ended your turn without a verdict. Call `factory_submit_review` now with `approve`, `request_changes` or `reject`.";

/** An agent writes the revert when the API cannot (main moved on after the merge). */
export function revertPrompt(opts: { sha: string; prNumber: number; title: string }): string {
  return [
    `CI on the default branch failed after pull request #${opts.prNumber} ("${opts.title}") was merged as ${opts.sha}.`,
    `Revert that commit in this worktree (\`git revert --no-edit ${opts.sha}\`), resolve conflicts conservatively, run the tests, and open a pull request titled \`Revert "${opts.title}"\` with \`create_pull_request\`. Do nothing else. Then call \`finish\`.`,
  ].join("\n");
}

/**
 * The PM's structured triage instructions for new candidates. `unattended` (dark factory): the
 * PM makes every judgement call itself and records it, since nobody is watching to answer.
 */
export function triageInstructions(items: FactoryItem[], unattended = false): string {
  return [
    `The factory has ${items.length} new candidate${items.length === 1 ? "" : "s"} to triage. Score each against the project vision (read it with read_project_notes or the vision file) and decide:`,
    ...items.map(
      (i) =>
        `- item ${i.id} [${i.source}${i.area ? `/${i.area}` : ""}] "${i.title}": ${i.summary.slice(0, 300)}${i.acceptanceCriteria.length ? ` | criteria: ${i.acceptanceCriteria.join("; ").slice(0, 400)}` : ""}`,
    ),
    "",
    "For each, call `factory_triage` with decision `accept` (a score from 0 to 1 and, if needed, sharper acceptance criteria) or `reject` (with the reason). Accepted items become GitHub issues and are built and merged automatically within the limits; reject anything outside the vision, too large, or touching protected areas.",
    "The vision wins over the current code. When the code doesn't match it (a different stack or architecture, say), the work that brings it in line comes first: score it highest, or open it with `create_issue` if no candidate covers it (new issues become candidates). Reject work that change would throw away, saying it waits for it.",
    unattended
      ? "This project runs as a dark factory: nobody is watching, so never ask the user. Make every judgement call yourself from the vision and record the ones that matter with `factory_record_decision` (the user reviews them in the inbox and the daily digest). Flag `needsHuman` only for a protected area, a missing or self-contradicting vision, or something irreversible outside the code, and triage everything else meanwhile."
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
