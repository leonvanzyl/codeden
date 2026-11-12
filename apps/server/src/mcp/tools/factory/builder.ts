import {
  FactoryAnalysisReport,
  FactoryReproductionReport,
  REVIEW_SUMMARY_MAX,
  ReviewVerdictSubmission,
  truncateReviewSummary,
} from "@codeden/contracts";
import { defineTool } from "../../define";
import { asTool, forSession } from "./shared";

/** The pipelines' agent tools (§10.1): the builder's first step and the reviewer's verdict. */

/** `factory_report_reproduction`: the bug pipeline's Reproduce step. */
export const factoryReportReproduction = defineTool({
  name: "factory_report_reproduction",
  description:
    "Report the Reproduce step of the bug you are working on: `reproduced: true` with how (steps), the failing output and the path of the failing test or probe you wrote; or `reproduced: false` with what you tried and what is missing. The answer tells you the next step (Create fix), or to stop.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.factory.isBuilder(id)),
  input: FactoryReproductionReport,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.reportReproduction(services.sessionRepo.get(sessionId), input)),
});

/** `factory_submit_analysis`: the feature pipeline's Analyze step. */
export const factorySubmitAnalysis = defineTool({
  name: "factory_submit_analysis",
  description:
    "Report the Analyze step of the feature request you are working on: `implement` with a short spec and testable acceptance criteria, or `already_done`, `needs_info` or `out_of_scope` with the reason. The answer tells you the next step (Implement), or to stop.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.factory.isBuilder(id)),
  input: FactoryAnalysisReport,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.submitAnalysis(services.sessionRepo.get(sessionId), input)),
});

const SUMMARY_MAX = REVIEW_SUMMARY_MAX.toLocaleString("en-US");

/**
 * `factory_submit_review`: the independent reviewer's structured verdict. A summary over
 * `REVIEW_SUMMARY_MAX` is stored truncated rather than rejected, so a verdict is never lost
 * over its length; the full text stays in the reviewer's session (its tool call).
 */
export const factorySubmitReview = defineTool({
  name: "factory_submit_review",
  description: `Submit your review verdict for the factory pull request you were asked to review: \`approve\`, \`request_changes\` (it goes back to the author for a revision) or \`reject\`, a specific summary (up to ${SUMMARY_MAX} characters are stored; a longer one is cut), one entry per acceptance criterion (met or not), whether it fits the vision, whether its tests are adequate (or none are needed), and any security concerns. Submit one verdict; if the call is rejected for invalid input, fix what the error names and call it again.`,
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession(
    (services, id) =>
      services.sessionRepo.find(id)?.session.workKey.startsWith("factory:review:") ?? false,
  ),
  input: ReviewVerdictSubmission,
  handler: async (input, { services, sessionId }) => {
    const verdict = { ...input, summary: truncateReviewSummary(input.summary) };
    const res = await asTool(() =>
      services.factory.submitReview(services.sessionRepo.get(sessionId), verdict),
    );
    if (!res.recorded || verdict.summary === input.summary) return res;
    const length = input.summary.length.toLocaleString("en-US");
    return {
      ...res,
      message: `${res.message} Your summary was ${length} characters, so it was stored cut to ${SUMMARY_MAX}; the full text stays in this session. Don't submit it again.`,
    };
  },
});
