import type {
  FactoryLimits,
  FactoryTuning,
  MergeCheck,
  MergeCheckName,
  MergeCheckState,
  ProtectedAreas,
  ReviewVerdict,
  WorkType,
} from "@codeden/contracts";
import type { FactoryPr } from "./github-port";
import { isNonCodeFile, isTestFile, isUiFile, protectedHits } from "./policy";
import { changeSize, overSizeLimit, sizeLimitText } from "./size";

/** Everything the merge checks look at for one pull request. */
export interface CheckInputs {
  pr: FactoryPr;
  issueTitle: string | null;
  review: ReviewVerdict | null;
  /** Provider of the reviewer, for the pending message. */
  reviewer: string | null;
  /** The item's pipeline; a docs change that touches no code needs no agent review. */
  type: WorkType | null;
  /** Screenshots attached; null when not looked up (no UI files). */
  evidence: boolean | null;
  /** Test output attached with `attach_evidence`; null when not looked up. */
  testOutput: boolean | null;
  /** Result of the configured audit command; null while not run (or not configured). */
  audit: { ok: boolean; detail: string } | null;
  auditConfigured: boolean;
  /**
   * True once CI had its time to start on this head commit (measured from when the factory
   * first saw the head); before that "no checks" counts as not reported yet.
   */
  ciTimedOut: boolean;
  limits: FactoryLimits;
  tuning: FactoryTuning;
  /** Why the PM let this item go over the size limit; null when it didn't. */
  largeChange: string | null;
  areas: ProtectedAreas;
  now: string;
}

/** Overall result: merge, wait, fix (or fail), or hand to a human. */
export type ChecksOutcome = "pass" | "pending" | "fail" | "escalate";

const ORDER: MergeCheckName[] = [
  "protected_paths",
  "size",
  "ci",
  "review",
  "tests",
  "test_results",
  "security",
  "ui_evidence",
];

/** A `## Test results` section in the PR description. */
const TEST_RESULTS_HEADING = /^#{1,6}\s*test results\b/im;

/** Whether the PR description reports test results. */
export function hasTestResults(body: string): boolean {
  return TEST_RESULTS_HEADING.test(body);
}

/** The `ci` check's detail while the PR has merge conflicts (the author is asked to rebase). */
export const CONFLICTS_DETAIL =
  "Merge conflicts with the base branch: GitHub runs no CI until they are resolved, so the author is rebasing";

const NEVER_STARTED = "CI never started on ";

/** Why the `ci` check failed when no CI ever reported on the head commit. */
export function ciNeverStarted(headSha: string | null): string {
  const head = headSha ? headSha.slice(0, 7) : "the head commit";
  return `${NEVER_STARTED}${head}: is the workflow disabled, or are GitHub Actions turned off for the repository? Fix that and re-run CI, or turn off "Require CI" in the factory settings`;
}

/** A failed check the author can't fix in code: CI that never started. */
export function notAuthorFixable(check: MergeCheck): boolean {
  return check.name === "ci" && (check.detail ?? "").startsWith(NEVER_STARTED);
}

/** Code files of a change (not tests, docs, config or assets). */
export function codeFiles(files: readonly string[]): string[] {
  return files.filter((f) => !isTestFile(f) && !isNonCodeFile(f));
}

function list(items: string[], max = 5): string {
  return items.length > max
    ? `${items.slice(0, max).join(", ")} and ${items.length - max} more`
    : items.join(", ");
}

/**
 * Evaluate the merge checks (§10.1 step 4). Pure: the caller gathers the inputs (PR details,
 * the reviewer's verdict, evidence, audit) and records the result on the item.
 */
export function evaluateChecks(i: CheckInputs): { checks: MergeCheck[]; outcome: ChecksOutcome } {
  const out = new Map<MergeCheckName, MergeCheck>();
  const set = (
    name: MergeCheckName,
    state: MergeCheckState,
    detail: string | null,
    escalate = false,
  ) => out.set(name, { name, state, detail, escalate, at: i.now });
  const files = i.pr.files;

  const hits = protectedHits({
    files,
    text: [i.pr.title, i.pr.body, i.issueTitle ?? ""].join("\n"),
    limits: i.limits,
    areas: i.areas,
  });
  if (hits.paths.length > 0 || hits.topics.length > 0) {
    const parts = [
      hits.paths.length ? `paths: ${list(hits.paths.map((h) => h.path))}` : "",
      hits.topics.length ? `topics: ${hits.topics.join(", ")}` : "",
    ].filter(Boolean);
    set("protected_paths", "fail", `Touches protected areas (${parts.join("; ")})`, true);
  } else set("protected_paths", "pass", null);

  const size = changeSize(i.pr);
  const measured = `${size.lines.toLocaleString("en")} lines in ${size.files} files${size.uncounted ? ` (${size.uncounted} lockfiles or generated files not counted)` : ""}`;
  if (!overSizeLimit(size, i.tuning)) set("size", "pass", measured);
  else if (i.largeChange) set("size", "pass", `${measured}; allowed by the PM: ${i.largeChange}`);
  else set("size", "fail", `${measured}, over the limit of ${sizeLimitText(i.tuning)}`);

  // A PR with merge conflicts can't merge and gets no new CI: it waits for the author's rebase
  // (red CI on it still fails, so the revise round fixes both).
  if (i.pr.mergeable === "conflicting" && i.pr.checks !== "failure")
    set("ci", "pending", CONFLICTS_DETAIL);
  else
    switch (i.pr.checks) {
      case "success":
        set("ci", "pass", null);
        break;
      case "failure":
        set("ci", "fail", `CI failed: ${list(i.pr.failedChecks) || "see the PR"}`);
        break;
      case "pending":
        set("ci", "pending", "CI is running");
        break;
      case "none":
        if (!i.tuning.requireCi) set("ci", "skipped", "No CI configured (not required)");
        else if (!i.ciTimedOut)
          set(
            "ci",
            "pending",
            `Waiting for CI to start on ${i.pr.headSha?.slice(0, 7) ?? "the head"}`,
          );
        else set("ci", "fail", ciNeverStarted(i.pr.headSha));
        break;
    }

  const code = codeFiles(files);
  // The docs pipeline has no agent review (Implement docs change -> Merge), as long as the
  // change really is docs only; anything touching code is reviewed like any other change.
  const reviewed = !(i.type === "docs" && code.length === 0);
  if (!reviewed)
    set("review", "skipped", "Docs-only change: the docs pipeline has no agent review");
  else if (!i.review)
    set("review", "pending", `Waiting for the review${i.reviewer ? ` (${i.reviewer})` : ""}`);
  else if (i.review.verdict === "approve") set("review", "pass", i.review.summary);
  else set("review", "fail", `${i.review.verdict}: ${i.review.summary}`);

  const tests = files.filter(isTestFile);
  if (code.length === 0) set("tests", "pass", "No code changed");
  else if (!i.review)
    set(
      "tests",
      "pending",
      tests.length
        ? `${tests.length} test files changed`
        : "No test files changed; waiting for the reviewer",
    );
  else if (!i.review.tests.adequate)
    set(
      "tests",
      "fail",
      `Reviewer: tests are not adequate${i.review.tests.note ? ` (${i.review.tests.note})` : ""}`,
    );
  else if (tests.length === 0 && !i.review.tests.notNeeded)
    set("tests", "fail", "Code changed but no test files were added or updated");
  else
    set(
      "tests",
      "pass",
      tests.length ? `${tests.length} test files changed` : "Reviewer: no tests needed",
    );

  if (hasTestResults(i.pr.body)) set("test_results", "pass", "Test results in the PR description");
  else if (i.testOutput === true) set("test_results", "pass", "Test output attached");
  else if (code.length === 0) set("test_results", "skipped", "No code changed");
  else if (i.testOutput === null) set("test_results", "pending", "Checking for test results");
  else
    set(
      "test_results",
      "fail",
      "No test results: add a `## Test results` section to the PR or attach the test output with attach_evidence",
    );

  const concerns = i.review?.security.concerns ?? [];
  if (i.auditConfigured && i.audit && !i.audit.ok)
    set("security", "fail", `Audit failed: ${i.audit.detail}`);
  else if (concerns.length > 0) set("security", "fail", `Reviewer: ${concerns.join("; ")}`);
  else if (!reviewed && !(i.auditConfigured && !i.audit))
    set(
      "security",
      "pass",
      i.auditConfigured ? "Audit clean; docs-only change" : "Docs-only change",
    );
  else if ((i.auditConfigured && !i.audit) || !i.review)
    set(
      "security",
      "pending",
      i.auditConfigured && !i.audit
        ? "Audit not run yet"
        : "Waiting for the reviewer's security pass",
    );
  else
    set(
      "security",
      "pass",
      i.auditConfigured
        ? `Audit clean; ${i.audit?.detail ?? ""}`.trim()
        : "Reviewer found no security concerns",
    );

  const ui = files.filter(isUiFile);
  if (ui.length === 0) set("ui_evidence", "skipped", "No UI files changed");
  else if (i.evidence === true) set("ui_evidence", "pass", "Screenshots attached");
  else if (i.evidence === null) set("ui_evidence", "pending", "Checking for screenshots");
  else
    set(
      "ui_evidence",
      "fail",
      `UI files changed (${list(ui)}) but no screenshots were attached with attach_evidence`,
    );

  const checks = ORDER.flatMap((n) => {
    const c = out.get(n);
    return c ? [c] : [];
  });
  const outcome: ChecksOutcome = checks.some((c) => c.escalate)
    ? "escalate"
    : checks.some((c) => c.state === "fail")
      ? "fail"
      : checks.some((c) => c.state === "pending")
        ? "pending"
        : "pass";
  return { checks, outcome };
}

/** Checks that failed (for fix prompts and reasons). */
export function failedChecks(checks: MergeCheck[]): MergeCheck[] {
  return checks.filter((c) => c.state === "fail");
}

/** True when two check lists say the same (ignoring timestamps). */
export function sameChecks(a: MergeCheck[], b: MergeCheck[]): boolean {
  const strip = (l: MergeCheck[]) => JSON.stringify(l.map(({ at: _at, ...rest }) => rest));
  return strip(a) === strip(b);
}
