import { z } from "zod";
import { renderProjectDigest } from "../../../services/orchestration/digest";
import { defineTool, ToolError } from "../../define";

/** `get_project_status` (§8.4, always loaded): the PM's digest on demand. */
export const getProjectStatus = defineTool({
  name: "get_project_status",
  description:
    "Current state of this project: running and queued work (work key, purpose, status, progress, age), next scheduled automation runs, open inbox items, recent finishes and failures. The same digest you get with every message, refreshed now.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({}),
  handler: async (_input, { services, projectId }) =>
    renderProjectDigest(
      services.orchestration.projectStatus(projectId),
      Date.now(),
      services.orchestration.timezone(),
    ),
});

/** `list_scheduled_runs` (§8.4, always loaded). */
export const listScheduledRuns = defineTool({
  name: "list_scheduled_runs",
  description: "Upcoming scheduled automation runs of this project, soonest first.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ limit: z.int().min(1).max(50).optional() }),
  handler: async ({ limit }, { services, projectId }) => {
    const runs = services.orchestration.automation.listScheduledRuns(projectId, limit ?? 10);
    return { count: runs.length, runs };
  },
});

/** `skip_next_run` (§8.4, always loaded): e.g. a manual audit is still going. */
export const skipNextRun = defineTool({
  name: "skip_next_run",
  description:
    "Skip the next scheduled run of an automation in this project (for example because the same work started by hand will still be running).",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ automationId: z.string().min(1) }),
  handler: async ({ automationId }, { services, projectId }) => {
    const run = await services.orchestration.automation.skipNextRun(automationId, projectId);
    if (!run) throw new ToolError("That automation has no upcoming run");
    return { skipped: run };
  },
});

/** `pause_automation` (§8.4, always loaded). */
export const pauseAutomation = defineTool({
  name: "pause_automation",
  description: "Pause an automation in this project: no runs until resume_automation.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ automationId: z.string().min(1) }),
  handler: async ({ automationId }, { services, projectId }) => {
    await services.orchestration.automation.pause(automationId, projectId);
    return "Automation paused.";
  },
});

/** `resume_automation` (§8.4, always loaded). */
export const resumeAutomation = defineTool({
  name: "resume_automation",
  description: "Resume a paused automation in this project.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ automationId: z.string().min(1) }),
  handler: async ({ automationId }, { services, projectId }) => {
    await services.orchestration.automation.resume(automationId, projectId);
    return "Automation resumed.";
  },
});

/** `cancel_queued_run` (§8.4, always loaded). */
export const cancelQueuedRun = defineTool({
  name: "cancel_queued_run",
  description: "Cancel an automation run of this project that is queued and has not started.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ runId: z.string().min(1) }),
  handler: async ({ runId }, { services, projectId }) => {
    await services.orchestration.automation.cancelQueuedRun(runId, projectId);
    return "Queued run cancelled.";
  },
});
