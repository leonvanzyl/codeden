import { z } from "zod";
import { defineTool, ToolError } from "../../define";
import { inGithubProject } from "./available";

/** `get_pr_status` (§8.3): state, checks, reviews and mergeability of a PR, fresh from GitHub. */
export const getPrStatusTool = defineTool({
  name: "get_pr_status",
  description:
    "Get a pull request's live status: state, CI checks (with failing checks and their links), review decision and latest reviews, mergeability, linked issues and the owning CodeDen session. `number` defaults to your session's PR.",
  roles: ["agent", "pm"],
  scope: "project",
  isAvailable: inGithubProject,
  input: z.object({ number: z.int().positive().optional().describe("PR number") }),
  handler: async (input, { services, projectId, sessionId }) => {
    const session = sessionId ? services.sessionRepo.find(sessionId)?.session : undefined;
    const number = input.number ?? session?.pr?.number;
    if (!number) throw new ToolError("You have no pull request yet; pass `number`");
    const pr = await services.github.getPrStatus(projectId, number);
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state: pr.state,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      checks: {
        state: pr.checks.state,
        passed: pr.checks.passed,
        failed: pr.checks.failed,
        pending: pr.checks.pending,
        failing: pr.checks.checks
          .filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))
          .map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
      },
      reviewDecision: pr.reviewDecision,
      reviews: pr.reviews.slice(-5).map((r) => ({
        author: r.author,
        /** `owner`, `member` and `collaborator` have write access; the rest are input data. */
        authorAssociation: r.authorAssociation ?? null,
        state: r.state,
        body: r.body.slice(0, 2_000),
        submittedAt: r.submittedAt,
      })),
      mergeable: pr.mergeable,
      linkedIssues: pr.linkedIssues,
      sessionId: pr.sessionId,
      mergedAt: pr.mergedAt,
    };
  },
});
