import {
  FactoryAnalysisReport,
  FactoryReproductionReport,
  ReviewVerdict,
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

/** `factory_submit_review`: the independent reviewer's structured verdict. */
export const factorySubmitReview = defineTool({
  name: "factory_submit_review",
  description:
    "Submit your review verdict for the factory pull request you were asked to review: `approve`, `request_changes` (it goes back to the author for a revision) or `reject`, a specific summary, one entry per acceptance criterion (met or not), whether it fits the vision, whether its tests are adequate (or none are needed), and any security concerns.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession(
    (services, id) =>
      services.sessionRepo.find(id)?.session.workKey.startsWith("factory:review:") ?? false,
  ),
  input: ReviewVerdict,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.submitReview(services.sessionRepo.get(sessionId), input)),
});
