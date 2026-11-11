import {
  FactoryFileIssueRequest,
  FactoryFinding,
  FactoryPlanRoundRequest,
} from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../../define";
import { asTool, forSession } from "./shared";

/** The dark factory's scout and lens tools (§10.1). */

/** `factory_plan_round`: the scout picks this round's lenses. */
export const factoryPlanRound = defineTool({
  name: "factory_plan_round",
  description:
    "Plan this review round: the lenses (long-lived reviewer agents, one per area) you want, each with a focus specific to this app. CodeDen starts or wakes them within the factory's limits and tells you which ran. An empty list means you review by yourself this round. Call once per round.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.factory.isScout(id)),
  input: FactoryPlanRoundRequest,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.planRound(services.sessionRepo.get(sessionId), input)),
});

/** `factory_file_issue`: the scout files one piece of work as a GitHub issue. */
export const factoryFileIssue = defineTool({
  name: "factory_file_issue",
  description:
    "File one improvement as a GitHub issue for the software factory: its type (bug, feature or docs, which picks the pipeline), a clear title, the body (what and why, grounded in the vision), testable acceptance criteria, a priority, and the finding ids it covers. It is queued for an agent straight away. Limited per round.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.factory.isScout(id)),
  input: FactoryFileIssueRequest,
  handler: async (input, { services, sessionId }) =>
    asTool(() => services.factory.fileIssue(services.sessionRepo.get(sessionId), input)),
});

/** `factory_report_findings`: a lens reports what it found this round. */
export const factoryReportFindings = defineTool({
  name: "factory_report_findings",
  description:
    "Report what you found this round (call once, at the end): each finding's title, why it matters for the vision, its type (bug, feature or docs), severity, testable acceptance criteria and the paths it would touch when you know them. An empty list means nothing is worth doing. The scout decides what to file.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.factory.isLens(id)),
  input: z.object({ findings: z.array(FactoryFinding).max(5) }),
  handler: async (input, { services, sessionId }) =>
    asTool(() =>
      services.factory.reportFindings(services.sessionRepo.get(sessionId), input.findings),
    ),
});
