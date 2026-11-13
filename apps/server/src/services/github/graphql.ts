import {
  type ChecksState,
  GithubAuthorAssociation,
  type GithubCheck,
  type GithubChecksSummary,
  type GithubPr,
  type GithubReview,
  githubPrId,
  type Mergeable,
  type ReviewDecision,
} from "@codeden/contracts";
import type { GithubClient } from "./client";

/** Batched GraphQL reads of pull requests: state, checks, reviews, mergeability, commits. */

const PR_FIELDS = `
fragment PrFields on PullRequest {
  number title url state isDraft merged mergedAt closedAt createdAt updatedAt body
  headRefName baseRefName headRefOid mergeable reviewDecision
  author { login }
  closingIssuesReferences(first: 10) { nodes { number } }
  commits(last: 50) { nodes { commit { oid messageHeadline } } }
  head: commits(last: 1) {
    nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } } } } }
  }
  reviews(last: 20) { nodes { id author { login } authorAssociation state body submittedAt url } }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename
    ... on User { login }
    ... on Bot { login }
    ... on Mannequin { login }
    ... on Team { combinedSlug }
  } } }
}`;

/** PRs per GraphQL request (aliases in one query). */
export const PR_BATCH_SIZE = 20;

interface GqlContext {
  __typename: "CheckRun" | "StatusContext";
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

/** A `PullRequest` node as returned by `PR_FIELDS`. */
export interface GqlPullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  author: { login: string } | null;
  closingIssuesReferences: { nodes: Array<{ number: number } | null> } | null;
  commits: { nodes: Array<{ commit: { oid: string; messageHeadline: string } } | null> };
  head: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: Array<GqlContext | null> };
        } | null;
      };
    } | null>;
  };
  reviewRequests?: {
    nodes: Array<{
      requestedReviewer: { __typename: string; login?: string; combinedSlug?: string } | null;
    } | null>;
  } | null;
  reviews: {
    nodes: Array<{
      id: string;
      author: { login: string } | null;
      /** `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ... */
      authorAssociation?: string;
      state: string;
      body: string;
      submittedAt: string | null;
      url: string | null;
    } | null>;
  };
}

/** A PR as read, with the account that read it. */
export interface FetchedPr {
  node: GqlPullRequest;
  /**
   * Login of the account the request ran as (GraphQL `viewer`, answered in the same request, so
   * it is the credential actually used, after any 401 refresh). Null when GitHub didn't say.
   */
  viewer: string | null;
}

/** Fetch up to `PR_BATCH_SIZE` PRs per request; missing numbers are left out. */
export async function fetchPullRequests(
  client: GithubClient,
  owner: string,
  repo: string,
  numbers: number[],
): Promise<FetchedPr[]> {
  const out: FetchedPr[] = [];
  const unique = [...new Set(numbers)];
  for (let i = 0; i < unique.length; i += PR_BATCH_SIZE) {
    const batch = unique.slice(i, i + PR_BATCH_SIZE);
    const fields = batch.map((n) => `pr${n}: pullRequest(number: ${n}) { ...PrFields }`).join("\n");
    const query = `query($owner: String!, $repo: String!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
${fields}
  }
}
${PR_FIELDS}`;
    const data = await client.graphql<{
      viewer?: { login?: string | null } | null;
      repository: Record<string, GqlPullRequest | null> | null;
    }>(query, { owner, repo });
    const viewer = data.viewer?.login || null;
    for (const node of Object.values(data.repository ?? {})) if (node) out.push({ node, viewer });
  }
  return out;
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

/** Summarise a head commit's check runs and commit statuses. */
export function summarizeChecks(
  rollup: { state: string; contexts: { nodes: Array<GqlContext | null> } } | null,
): GithubChecksSummary {
  const checks: GithubCheck[] = [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of rollup?.contexts.nodes ?? []) {
    if (!c) continue;
    if (c.__typename === "CheckRun") {
      const done = c.status === "COMPLETED";
      const conclusion = c.conclusion ?? null;
      if (!done) pending++;
      else if (conclusion && FAILED.has(conclusion)) failed++;
      else passed++;
      checks.push({
        name: c.name ?? "check",
        status: (c.status ?? "").toLowerCase(),
        conclusion: conclusion ? conclusion.toLowerCase() : null,
        url: c.detailsUrl ?? null,
      });
    } else {
      const state = c.state ?? "PENDING";
      const done = state !== "PENDING" && state !== "EXPECTED";
      if (!done) pending++;
      else if (FAILED.has(state)) failed++;
      else passed++;
      checks.push({
        name: c.context ?? "status",
        status: done ? "completed" : "pending",
        conclusion: done ? state.toLowerCase() : null,
        url: c.targetUrl ?? null,
      });
    }
  }
  return {
    state: rollupState(rollup?.state, checks.length),
    total: checks.length,
    passed,
    failed,
    pending,
    checks,
  };
}

function rollupState(state: string | undefined, count: number): ChecksState {
  if (!state || count === 0)
    return state === "PENDING" || state === "EXPECTED" ? "pending" : "none";
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "pending";
}

const REVIEW_STATES: Record<string, GithubReview["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

/**
 * GitHub's `CommentAuthorAssociation` (GraphQL) or `author_association` (REST); a value this
 * build doesn't know counts as `none`.
 */
export function authorAssociation(value: string | null | undefined): GithubAuthorAssociation {
  const parsed = GithubAuthorAssociation.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : "none";
}

/** Issue numbers named by closing keywords in a PR body (`Fixes #12`, `closes #3`). */
export function closingIssueNumbers(body: string): number[] {
  const out = new Set<number>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
  for (const m of body.matchAll(re)) out.add(Number(m[1]));
  return [...out];
}

/** Logins and team slugs a PR's review is requested from, sorted and de-duplicated. */
function requestedReviewers(node: GqlPullRequest): string[] {
  const out = new Set<string>();
  for (const r of node.reviewRequests?.nodes ?? []) {
    const who = r?.requestedReviewer;
    const name = who?.login ?? who?.combinedSlug;
    if (name) out.add(name);
  }
  return [...out].sort();
}

/** Map a GraphQL PR to the projection entity. `sessionId` is resolved by the caller. */
export function toGithubPr(
  projectId: string,
  node: GqlPullRequest,
  sessionId: string | null,
): GithubPr {
  const state: GithubPr["state"] = node.merged
    ? "merged"
    : node.state === "CLOSED"
      ? "closed"
      : node.isDraft
        ? "draft"
        : "open";
  const linked = new Set<number>(closingIssueNumbers(node.body ?? ""));
  for (const ref of node.closingIssuesReferences?.nodes ?? []) if (ref) linked.add(ref.number);
  const decision: ReviewDecision =
    node.reviewDecision === "APPROVED"
      ? "approved"
      : node.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : node.reviewDecision === "REVIEW_REQUIRED"
          ? "review_required"
          : "none";
  const mergeable: Mergeable =
    node.mergeable === "MERGEABLE"
      ? "mergeable"
      : node.mergeable === "CONFLICTING"
        ? "conflicting"
        : "unknown";
  return {
    id: githubPrId(projectId, node.number),
    projectId,
    number: node.number,
    title: node.title,
    state,
    url: node.url,
    author: node.author?.login ?? null,
    headBranch: node.headRefName,
    baseBranch: node.baseRefName,
    headSha: node.headRefOid,
    checks: summarizeChecks(node.head.nodes.at(-1)?.commit.statusCheckRollup ?? null),
    reviewDecision: decision,
    reviews: node.reviews.nodes
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({
        id: r.id,
        author: r.author?.login ?? null,
        authorAssociation: authorAssociation(r.authorAssociation),
        state: REVIEW_STATES[r.state] ?? "commented",
        body: r.body,
        submittedAt: r.submittedAt,
        url: r.url,
      })),
    mergeable,
    linkedIssues: [...linked].sort((a, b) => a - b),
    requestedReviewers: requestedReviewers(node),
    commits: node.commits.nodes
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({ sha: c.commit.oid, message: c.commit.messageHeadline })),
    sessionId,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
  };
}
