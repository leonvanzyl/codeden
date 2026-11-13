import { InboxItemKind } from "@codeden/contracts";
import { z } from "zod";
import { renderOverviewDigest } from "../../../services/orchestration/digest";
import { defineTool } from "../../define";
import { projectFor } from "../shared/helpers";

/** `get_overview` (§8.4, always loaded): every project rolled up. */
export const getOverview = defineTool({
  name: "get_overview",
  description:
    "Current state of every project: running and queued work (work key, purpose, status, progress, age), upcoming scheduled runs, open inbox items, recent finishes and failures, work running in several projects, and informational PM messages.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({}),
  handler: async (_input, { services }) =>
    renderOverviewDigest(
      services.orchestration.overview(),
      Date.now(),
      services.orchestration.timezone(),
    ),
});

/** `list_inbox` (§11.1): what is waiting on the user. */
export const listInbox = defineTool({
  name: "list_inbox",
  description:
    "Open inbox items (questions, approvals, PRs to review, failed runs, triage decisions, conflicts), optionally for one project or of one kind.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({
    projectId: z.string().min(1).optional(),
    kind: InboxItemKind.optional(),
  }),
  handler: async ({ projectId, kind }, { services }) => {
    const items = services.inbox
      .list(projectId ? { projectId } : {})
      .filter((i) => !kind || i.kind === kind)
      .slice(0, 50);
    return {
      open: items.length,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        body: i.body,
        projectId: i.projectId,
        sessionId: i.sessionId,
        createdAt: i.createdAt,
      })),
    };
  },
});

/** `message_pm` (§8.3): hand a PM a task or information without waiting. */
export const messagePm = defineTool({
  name: "message_pm",
  description:
    "Send a message to a project's PM without waiting for the answer (it reports back later with a message). Use ask_pm when you need the answer now.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({
    projectId: z.string().min(1),
    text: z.string().min(1).max(20_000),
  }),
  handler: async ({ projectId, text }, { services, caller, sessionId }) => {
    const project = projectFor(services, projectId);
    const res = await services.orchestration.messagePm(projectId, text, { caller, sessionId });
    if (res.status === "held") {
      return `${heldNote(project.name, res.until)} Its reply arrives as a later message.`;
    }
    return `Message ${res.status} to the PM of ${project.name} (session ${res.sessionId}). Its reply arrives as a later message.`;
  },
});

/**
 * What the orchestrator is told about a message the loop guard held back (§8.2): it is
 * queued and delivered automatically, so there is nothing to wait for or retry.
 */
export function heldNote(projectName: string, until: number, now = Date.now()): string {
  const when = until - now <= 60_000 ? "within a minute" : `at about ${clock(until)} (local time)`;
  return [
    `Queued: CodeDen delivers this to the PM of ${projectName} automatically ${when}, or sooner if the PM wakes up for something else.`,
    "Nothing else to do: do not send it again or plan a retry.",
    "(CodeDen paces automatic back-and-forth between you and a PM while the user has not stepped in.)",
  ].join(" ");
}

/** `HH:MM` in the server's (the user's) local time. */
const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** `ask_pm` (§8.3): ask a PM and wait for its answer. */
export const askPm = defineTool({
  name: "ask_pm",
  description:
    "Ask a project's PM a question or pass it a request and wait for its answer (default up to 3 minutes). The PM knows everything running and scheduled in its project, so ask it before any work is started there. If the answer does not arrive in time the call returns 'pending' and the answer arrives later as a message.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({
    projectId: z.string().min(1),
    question: z.string().min(1).max(20_000),
    timeoutSec: z.int().min(10).max(540).optional(),
  }),
  handler: async ({ projectId, question, timeoutSec }, { services, caller, sessionId, signal }) => {
    const project = projectFor(services, projectId);
    const outcome = await services.orchestration.askPm(projectId, question, {
      origin: { caller, sessionId },
      timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
      signal,
    });
    if (outcome.status === "held") {
      return `pending: ${heldNote(project.name, outcome.until)} Do not ask again; the PM's answer arrives as a message.`;
    }
    if (outcome.status === "answered") {
      return `The PM of ${project.name} answered:\n${outcome.text}`;
    }
    return `pending: the PM of ${project.name} is still working on it. Do not ask again; its answer will arrive as a message.`;
  },
});
