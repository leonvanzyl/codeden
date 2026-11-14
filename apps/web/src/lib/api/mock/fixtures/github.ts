import type { GithubChecksSummary, GithubIssue, GithubPrDetails } from "@codeden/contracts";
import { mockPrFile } from "./github-pr-diffs";
import { ago } from "./helpers";

const SF = "https://github.com/hearth-co/storefront";

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "error"]);

/**
 * A checks summary from `[name, conclusion]` pairs; a `null` conclusion is still running, and
 * `"queued"` hasn't started.
 */
export function checks(list: [string, string | null][]): GithubChecksSummary {
  const failed = list.filter(([, c]) => c !== null && FAILED.has(c)).length;
  const pending = list.filter(([, c]) => c === null || c === "queued").length;
  return {
    state: list.length === 0 ? "none" : failed ? "failure" : pending ? "pending" : "success",
    total: list.length,
    passed: list.length - failed - pending,
    failed,
    pending,
    checks: list.map(([name, c]) => ({
      name,
      status: c === null ? "in_progress" : c === "queued" ? "queued" : "completed",
      conclusion: c === null || c === "queued" ? null : c,
      url: null,
    })),
  };
}

/** PR 57's checks: e2e is running and the preview deploy is queued. */
export const searchPrChecks: [string, string | null][] = [
  ["ci / typecheck", "success"],
  ["ci / lint", "success"],
  ["ci / unit", "success"],
  ["ci / e2e", null],
  ["preview / deploy", "queued"],
  ["docs / build", "skipped"],
];

/** PR 57 a little later: e2e passed and the deploy started. */
export const searchPrChecksLater: [string, string | null][] = [
  ["ci / typecheck", "success"],
  ["ci / lint", "success"],
  ["ci / unit", "success"],
  ["ci / e2e", "success"],
  ["preview / deploy", null],
  ["docs / build", "skipped"],
];

function issue(
  number: number,
  title: string,
  labels: string[],
  minutesAgo: number,
  sessionIds: string[] = [],
): GithubIssue {
  return {
    projectId: "p-storefront",
    number,
    title,
    state: "open",
    url: `${SF}/issues/${number}`,
    labels,
    author: "maya-k",
    body: null,
    comments: 2,
    createdAt: ago(minutesAgo),
    updatedAt: ago(minutesAgo / 2),
    closedAt: null,
    sessionIds,
  };
}

/** Storefront's open issues in the mock. */
export const mockIssues: GithubIssue[] = [
  issue(151, "Dark mode for the storefront", ["enhancement", "ui"], 300),
  issue(142, "Checkout e2e test is flaky on CI", ["bug", "tests", "ci"], 900, ["s-checkout"]),
  issue(139, "Product search with category and price filters", ["enhancement"], 2000, ["s-search"]),
  issue(131, "Image CDN returns 403 for webp", ["bug"], 4000),
];

function pr(
  number: number,
  title: string,
  state: "draft" | "open",
  sessionId: string,
  extra: Partial<GithubPrDetails>,
): GithubPrDetails {
  const files = extra.files ?? [];
  return {
    id: `p-storefront:${number}`,
    projectId: "p-storefront",
    number,
    title,
    state,
    url: `${SF}/pull/${number}`,
    author: "codeden-bot",
    headBranch: `codeden/${sessionId.slice(2)}`,
    baseBranch: "main",
    headSha: "4b1c9e2",
    checks: checks([]),
    reviewDecision: "review_required",
    reviews: [],
    mergeable: "mergeable",
    linkedIssues: [],
    commits: [],
    sessionId,
    createdAt: ago(120),
    updatedAt: ago(10),
    mergedAt: null,
    closedAt: null,
    body: "",
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    files,
    ...extra,
  };
}

/** Storefront's open PRs with live details. */
export const mockPrs: GithubPrDetails[] = [
  pr(58, "Accessibility fixes on the product page", "open", "s-a11y", {
    body: "Raises contrast to AA, restores focus rings and adds alt text to 14 images.",
    checks: checks([
      ["ci / typecheck", "success"],
      ["ci / unit", "success"],
      ["ci / e2e", "success"],
    ]),
    reviewDecision: "approved",
    reviews: [
      {
        id: "r1",
        author: "maya-k",
        state: "approved",
        body: "Looks great.",
        submittedAt: ago(30),
        url: null,
      },
    ],
    commits: [{ sha: "4b1c9e2", message: "fix(a11y): contrast, focus rings and alt text" }],
    files: [
      mockPrFile("src/pages/product.tsx", "modified"),
      mockPrFile("src/theme/tokens.css", "modified"),
      // Binary: GitHub sends no patch.
      mockPrFile("public/images/hero.webp", "added"),
    ],
  }),
  pr(57, "Product search with filters", "draft", "s-search", {
    body: "Fixes #139.\n\n- Category chips and max-price filter\n- URL is the source of truth",
    checks: checks(searchPrChecks),
    linkedIssues: [139],
    files: [
      mockPrFile("src/search/SearchFilters.tsx", "added"),
      mockPrFile("src/search/index.ts", "modified"),
    ],
  }),
  pr(55, "Serve webp through the image CDN", "open", "s-cdn", {
    body: "Fixes #131. Adds `image/webp` to the CDN's allowed types.",
    sessionId: null,
    checks: checks([
      ["ci / typecheck", "success"],
      ["ci / unit", "failure"],
      ["ci / e2e", "timed_out"],
      ["ci / lighthouse", "cancelled"],
      ["security / audit", "neutral"],
    ]),
    linkedIssues: [131],
    files: [mockPrFile("infra/cdn.ts", "modified")],
  }),
];
