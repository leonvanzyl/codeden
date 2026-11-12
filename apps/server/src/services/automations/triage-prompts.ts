import type {
  Automation,
  AutomationRun,
  GitHubIssueRef,
  GithubIssue,
  TriagePolicy,
} from "@codeden/contracts";
import { UNTRUSTED_INPUT } from "../factory/prompts";

/**
 * The texts of issue triage (§10): the request a triage run sends to the PM, and the brief of
 * the agent session that resolves a ready issue. Pure, so tests can check the wording. Both
 * carry the factory's untrusted-input rule: on a public repository anyone writes issues.
 */

/** The PM's instructions for one triage run. `canStart`: ready issues start a session. */
export function triageRequestText(opts: {
  automation: Automation;
  run: Pick<AutomationRun, "id">;
  issue: GithubIssue | GitHubIssueRef;
  policy: TriagePolicy;
  canStart: boolean;
}): string {
  const { automation, run, issue, policy } = opts;
  const labels = Object.entries(policy.labels)
    .map(([decision, names]) => `  - ${decision}: ${names.length ? names.join(", ") : "(none)"}`)
    .join("\n");
  return [
    `Issue triage (automation "${automation.name}", run ${run.id}).`,
    `New issue #${issue.number}: ${issue.title ?? ""}`,
    issue.url,
    "",
    "1. Read it with get_issue (and list_issues to look for duplicates). Compare it with the project notes, the vision and the work already running.",
    "2. Classify it as exactly one of: ready (clear, in scope, safe to implement), needs_info (unclear or missing reproduction), unsafe (touches protected areas or needs a human decision), out_of_scope, duplicate.",
    `3. Apply it with triage_issue using these labels:\n${labels}`,
    policy.comment
      ? "   Include a short, friendly comment explaining the decision (for needs_info, ask the specific questions)."
      : "   Do not comment on the issue.",
    policy.closeRejected
      ? "   Close duplicates and out-of-scope issues (close: true)."
      : "   Do not close the issue.",
    "4. Then call report_triage with the issue number, the decision and a two-sentence summary.",
    opts.canStart
      ? "   For ready issues by trusted authors (the project's trusted authors, the account CodeDen uses on GitHub, or people with write access to the repository) CodeDen starts an agent session automatically; for anyone else's it asks the user. Do not call start_session yourself."
      : "   For ready issues CodeDen asks the user whether to take it on; do not call start_session yourself.",
    "Decide the classification yourself and don't call ask_user: nobody answers during a triage run, and a run that waits never reports. When you can't tell, choose needs_info or unsafe and say why in the summary.",
    UNTRUSTED_INPUT,
    automation.action.type === "triage" && automation.action.instructions
      ? `\nProject guidance:\n${automation.action.instructions}`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The brief of the agent session that resolves a triaged issue. */
export function issueSessionPrompt(issue: GitHubIssueRef, summary: string): string {
  const title = issue.title ?? `Issue #${issue.number}`;
  return [
    `Resolve GitHub issue #${issue.number}: ${title}`,
    issue.url,
    summary ? `\nTriage summary: ${summary}` : "",
    "",
    `Read the full issue and its comments first (\`gh issue view ${issue.number} --comments\`). Implement the change in your worktree following the project's conventions, add or update tests that prove it, and run the test suite.`,
    `Then open a pull request with create_pull_request whose body includes "Fixes #${issue.number}", attach evidence (test output, and screenshots for UI changes) with attach_evidence, and call finish. If a detail is unclear, make the reasonable call within the issue's scope and state the assumption in the pull request description. Ask with ask_user only if the change needs a protected area or a destructive or outward-facing step.`,
    UNTRUSTED_INPUT,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
