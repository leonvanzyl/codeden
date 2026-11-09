import {
  FactoryCandidate,
  FactoryDecisionRequest,
  FactoryTriageRequest,
  isFactoryMode,
  ReviewVerdict,
} from "@codeden/contracts";
import { z } from "zod";
import type { AppServices } from "../../../services/container";
import { ServiceError } from "../../../services/errors";
import {
  type AnyServerTool,
  defineTool,
  type ToolAvailabilityContext,
  ToolError,
} from "../../define";

/** Factory tools (§10.1): improvement finders, reviewers and the PM's triage. */

function sessionWorkKey(services: AppServices, caller?: ToolAvailabilityContext): string | null {
  if (!caller?.sessionId) return null;
  return services.sessionRepo.find(caller.sessionId)?.session.workKey ?? null;
}

function inFactoryProject(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  if (!caller) return true;
  if (!caller.projectId) return false;
  try {
    return isFactoryMode(services.projects.get(caller.projectId).autonomyMode);
  } catch {
    return false;
  }
}

/** Service errors become tool errors the agent can read. */
async function asTool<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) throw new ToolError(error.message);
    throw error;
  }
}

/** `factory_report_candidates`: an improvement finder reports what it found. */
export const factoryReportCandidates = defineTool({
  name: "factory_report_candidates",
  description:
    "Report the improvements you found for the factory loop (call once, at the end). Each candidate needs a title, a summary of why it matters for the vision, and testable acceptance criteria; add the paths it would touch when you know them. An empty list means you found nothing worth doing. The PM scores them against the vision.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: (services, caller) => {
    if (!caller) return true;
    return sessionWorkKey(services, caller)?.startsWith("factory:discover:") ?? false;
  },
  input: z.object({ candidates: z.array(FactoryCandidate).max(5) }),
  handler: async (input, { services, sessionId }) =>
    asTool(() =>
      services.factory.reportCandidates(services.sessionRepo.get(sessionId), input.candidates),
    ),
});

/** `factory_submit_review`: the independent reviewer's structured verdict. */
export const factorySubmitReview = defineTool({
  name: "factory_submit_review",
  description:
    "Submit your review verdict for the factory pull request you were asked to review: `approve`, `request_changes` or `reject`, a specific summary, one entry per acceptance criterion (met or not), whether it fits the vision, whether its tests are adequate (or none are needed), and any security concerns. CodeDen merges automatically only on `approve` with every other merge check green.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: (services, caller) => {
    if (!caller) return true;
    return sessionWorkKey(services, caller)?.startsWith("factory:review:") ?? false;
  },
  input: ReviewVerdict,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.submitReview(services.sessionRepo.get(sessionId), input)),
});

/** `factory_status`: the PM's view of the loop, candidates included. */
export const factoryStatus = defineTool({
  name: "factory_status",
  description:
    "The factory loop of this project: state, limits, spend against the daily budget, candidates waiting for your triage, the backlog, items in progress with their merge checks, and recent merges, failures and reverts.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  isAvailable: inFactoryProject,
  input: z.object({}),
  handler: async (_input, { services, projectId }) => {
    const s = services.factory.status(projectId);
    const candidates = services.factory.data.items(projectId, ["candidate"]).map((i) => ({
      itemId: i.id,
      source: i.source,
      area: i.area,
      title: i.title,
      summary: i.summary,
      acceptanceCriteria: i.acceptanceCriteria,
    }));
    return {
      mode: s.mode,
      loopState: s.loopState,
      pausedReason: s.pausedReason,
      limits: s.limits,
      spendToday: s.spendToday,
      mergesToday: s.mergesToday,
      consecutiveFailures: s.consecutiveFailures,
      candidates,
      backlog: s.backlog.filter((i) => i.stage === "backlog"),
      inProgress: s.inProgress,
      mergeChecks: s.mergeChecks,
      recent: s.recent.slice(0, 10),
    };
  },
});

/** `factory_triage`: accept (with a score and criteria) or reject (with a reason) a candidate. */
export const factoryTriage = defineTool({
  name: "factory_triage",
  description:
    "Decide on a factory candidate after scoring it against the vision. `accept` with a score (0..1) and, if needed, sharper acceptance criteria: CodeDen creates the GitHub issue and builds it within the limits. `reject` with the reason (outside the vision, too big, touches protected areas, duplicate).",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  isAvailable: inFactoryProject,
  input: FactoryTriageRequest,
  handler: async (input, { services, projectId }) =>
    asTool(async () => {
      const item = await services.factory.triage(projectId, input);
      return { itemId: item.id, stage: item.stage, issue: item.issue, workKey: item.workKey };
    }),
});

/** `factory_record_decision`: a dark-factory agent records a call it made instead of asking. */
export const factoryRecordDecision = defineTool({
  name: "factory_record_decision",
  description:
    "Record a decision you made on your own instead of asking the user (this project runs as a dark factory, so nobody waits to answer). Give the question you would have asked, what you decided and why, grounded in the vision. It goes to the user's inbox and the daily digest so they can review or override it; nothing waits on it. Set `needsHuman` only for a protected area, a missing or self-contradicting vision, or something irreversible outside the code: that flags it for the user, and you carry on with the work that doesn't depend on it.",
  roles: ["agent", "pm"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: (services, caller) => {
    if (!caller) return true;
    return caller.sessionId !== null && services.factory.isUnattended(caller.sessionId);
  },
  input: FactoryDecisionRequest,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.recordDecision(services.sessionRepo.get(sessionId), input)),
});

export const factoryTools: AnyServerTool[] = [
  factoryReportCandidates,
  factorySubmitReview,
  factoryStatus,
  factoryTriage,
  factoryRecordDecision,
];
