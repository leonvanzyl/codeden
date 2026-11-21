import { z } from "zod";
import { NOTES_PATH } from "../../../services/orchestration/notes";
import { defineTool, ToolError } from "../../define";
import { memoryWrite } from "../shared/memory-writes";

/**
 * `read_project_notes` (§8.3): the project's durable memory, kept by its PM and shared with its
 * agents (the project counterpart of group memory, DESIGN.md "Project groups").
 */
export const readProjectNotes = defineTool({
  name: "read_project_notes",
  description: `Read this project's notes (${NOTES_PATH}): decisions, conventions and follow-ups recorded earlier by its PM and agents. Facts shared across a project group are in read_group_memory.`,
  roles: ["pm", "agent"],
  scope: "project",
  input: z.object({}),
  handler: async (_input, { services, projectId }) => {
    const content = services.orchestration.notes.read(projectId);
    return content.trim() ? content : "(no notes yet)";
  },
});

/** `update_project_notes` (§8.3): written by the server; the PM has no write access. */
export const updateProjectNotes = defineTool({
  name: "update_project_notes",
  description: `Update this project's notes (${NOTES_PATH}) with facts about this project only; facts shared across a project group go to update_group_memory. mode 'append' (default) adds a section; 'replace' rewrites them (project managers only). Keep them short and current, and never write secrets.`,
  roles: ["pm", "agent"],
  scope: "project",
  input: z.object({
    content: z.string().min(1).max(100_000),
    mode: z.enum(["append", "replace"]).optional(),
  }),
  handler: async ({ content, mode = "append" }, { services, projectId, role, sessionId }) => {
    const text = await memoryWrite(services, { role, sessionId }, content, mode);
    const next = services.orchestration.notes.write(projectId, text, mode);
    return `Notes saved (${Buffer.byteLength(next, "utf8")} bytes).`;
  },
});

/** `message_orchestrator` (§8.2): report to the orchestrator; informational ones never wake it. */
export const messageOrchestrator = defineTool({
  name: "message_orchestrator",
  description:
    "Send a message to the orchestrator. Set informational: true for routine updates (they never wake it and show in its next status digest); leave it false only when the orchestrator must act or answer. replyTo answers an earlier question by its ask id.",
  roles: ["pm"],
  scope: "session",
  alwaysLoad: true,
  input: z.object({
    text: z.string().min(1).max(20_000),
    informational: z.boolean().optional(),
    replyTo: z.string().min(1).max(64).optional(),
  }),
  handler: async ({ text, informational, replyTo }, { services, sessionId }) => {
    const pm = services.sessionRepo.get(sessionId);
    if (!pm.projectId) throw new ToolError("Only a project's PM can message the orchestrator");
    const outcome = services.orchestration.messageOrchestrator(pm, text, {
      informational: informational ?? false,
      replyTo,
    });
    if (outcome === "answered") return "Your answer was returned to the orchestrator.";
    if (outcome === "noted") return "Noted: the orchestrator sees it in its next status digest.";
    return "Sent: the orchestrator will be woken with it shortly.";
  },
});
