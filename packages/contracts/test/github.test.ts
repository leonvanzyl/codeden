import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  GITHUB_EVENT_TYPES,
  GithubIssue,
  GithubListQuery,
  GithubPr,
  GithubPrDetails,
  GithubPrDiff,
  GithubReview,
  githubPrId,
  MergePrRequest,
  parseGithubPrId,
  SecretKey,
  TriageIssueRequest,
} from "../src";

const ts = "2026-11-07T10:00:00.000Z";

const issue: GithubIssue = {
  projectId: "p1",
  number: 3,
  title: "Bug",
  state: "open",
  url: "https://github.com/acme/widgets/issues/3",
  labels: ["bug"],
  author: "octo",
  body: null,
  comments: 0,
  createdAt: ts,
  updatedAt: ts,
  closedAt: null,
  sessionIds: [],
};

const pr: GithubPr = {
  id: "p1:4",
  projectId: "p1",
  number: 4,
  title: "Fix bug",
  state: "open",
  url: "https://github.com/acme/widgets/pull/4",
  author: "octo",
  headBranch: "codeden/fix",
  baseBranch: "main",
  headSha: "abc",
  checks: {
    state: "failure",
    total: 1,
    passed: 0,
    failed: 1,
    pending: 0,
    checks: [{ name: "ci", status: "completed", conclusion: "failure", url: null }],
  },
  reviewDecision: "review_required",
  reviews: [],
  mergeable: "mergeable",
  linkedIssues: [3],
  commits: [{ sha: "abc", message: "fix" }],
  sessionId: "s1",
  createdAt: ts,
  updatedAt: ts,
  mergedAt: null,
  closedAt: null,
};

describe("github contracts", () => {
  it("round-trips entities", () => {
    expect(GithubIssue.parse(JSON.parse(JSON.stringify(issue)))).toEqual(issue);
    expect(GithubPr.parse(JSON.parse(JSON.stringify(pr)))).toEqual(pr);
  });

  it("round-trips why an issue was closed, and reads issues stored without it (#265)", () => {
    const closed: GithubIssue = {
      ...issue,
      state: "closed",
      closedAt: ts,
      stateReason: "duplicate",
    };
    expect(GithubIssue.parse(JSON.parse(JSON.stringify(closed)))).toEqual(closed);
    expect(GithubIssue.parse(issue).stateReason).toBeUndefined();
    expect(GithubIssue.safeParse({ ...closed, stateReason: "reopened" }).success).toBe(false);
  });

  it("round-trips a review's author association, and reads reviews stored without it", () => {
    const review: GithubReview = {
      id: "r1",
      author: "lee",
      authorAssociation: "collaborator",
      state: "changes_requested",
      body: "Add a test.",
      submittedAt: ts,
      url: null,
    };
    const withReview = { ...pr, reviews: [review] };
    expect(GithubPr.parse(JSON.parse(JSON.stringify(withReview)))).toEqual(withReview);
    const { authorAssociation: _, ...stored } = review;
    expect(GithubReview.parse(stored).authorAssociation).toBeUndefined();
    expect(GithubReview.safeParse({ ...review, authorAssociation: "OWNER" }).success).toBe(false);
  });

  it("round-trips PR details and the PR diff", () => {
    const details: GithubPrDetails = {
      ...pr,
      body: "Fixes #3",
      additions: 4,
      deletions: 1,
      changedFiles: 3001,
      files: [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", previousPath: "src/old-b.ts", status: "renamed", additions: 1, deletions: 0 },
      ],
    };
    expect(GithubPrDetails.parse(JSON.parse(JSON.stringify(details)))).toEqual(details);
    const diff: GithubPrDiff = {
      headSha: "abc",
      changedFiles: 2,
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
        { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      ],
    };
    expect(GithubPrDiff.parse(JSON.parse(JSON.stringify(diff)))).toEqual(diff);
    expect(() => GithubPrDiff.parse({ ...diff, files: [{ path: "x", status: "added" }] })).toThrow();
  });

  it("parses every GitHub domain event in the envelope union", () => {
    expect(GITHUB_EVENT_TYPES).toContain("pr.checks_failed");
    const base = { seq: 1, sessionId: "s1", ts };
    const parsed = EventEnvelope.parse({ ...base, type: "pr.checks_failed", payload: { pr } });
    expect(parsed.type).toBe("pr.checks_failed");
    expect(
      EventEnvelope.parse({
        ...base,
        sessionId: null,
        type: "issue.labeled",
        payload: { issue, added: ["bug"] },
      }).type,
    ).toBe("issue.labeled");
    expect(
      EventEnvelope.parse({
        ...base,
        type: "github.synced",
        payload: { projectId: "p1", issues: [issue], prs: [pr] },
      }).type,
    ).toBe("github.synced");
    const comment = {
      id: 9,
      author: "lee",
      body: "Any update?",
      createdAt: ts,
      url: "https://github.com/acme/widgets/issues/3#issuecomment-9",
      fromCodeden: false,
    };
    const commented = EventEnvelope.parse({
      ...base,
      sessionId: null,
      type: "issue.commented",
      payload: { issue, comments: [comment] },
    });
    expect(commented.type === "issue.commented" && commented.payload.comments).toEqual([comment]);
    const requested = EventEnvelope.parse({
      ...base,
      type: "pr.review_requested",
      payload: { pr: { ...pr, requestedReviewers: ["lee"] }, reviewers: ["lee"] },
    });
    expect(requested.type === "pr.review_requested" && requested.payload.reviewers).toEqual([
      "lee",
    ]);
    const review = {
      id: "r1",
      author: "lee",
      authorAssociation: "none",
      state: "changes_requested",
      body: "Fix it",
      submittedAt: ts,
      url: null,
    };
    // The account the review was read with; older events have none.
    for (const viewer of [{ viewer: "octo" }, { viewer: null }, {}]) {
      const submitted = { ...base, type: "review.submitted", payload: { pr, review, ...viewer } };
      expect(EventEnvelope.parse(submitted)).toEqual(submitted);
    }
  });

  it("builds and parses PR ids", () => {
    expect(githubPrId("p:1-2", 7)).toBe("p:1-2:7");
    expect(parseGithubPrId("p:1-2:7")).toEqual({ projectId: "p:1-2", number: 7 });
    expect(parseGithubPrId("nope")).toBeNull();
    expect(parseGithubPrId("p:0")).toBeNull();
  });

  it("applies request defaults", () => {
    expect(MergePrRequest.parse({})).toEqual({ method: "squash" });
    expect(GithubListQuery.parse({ limit: "5" })).toEqual({ state: "open", limit: 5 });
    expect(TriageIssueRequest.parse({ decision: "needs_info" })).toEqual({
      decision: "needs_info",
      labels: [],
      removeLabels: [],
      close: false,
    });
    expect(SecretKey.options).toContain("github.token");
  });
});
