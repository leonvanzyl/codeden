import { z } from "zod";
import { wakesPm } from "../../../services/orchestration/notices";
import { defineTool, ToolError } from "../../define";
import { agentSessionOf } from "../shared/helpers";
import { questionItem } from "../shared/session-items";

/**
 * `answer_question` (§8.2 step 5): the PM answers a question one of its project's agent
 * sessions asked, so the agent carries on without waiting for the user. Only the agent's own
 * questions from work the PM, the orchestrator or an automation started. Approvals, MCP
 * servers' forms (their answers go to an external tool as data, §11.2) and the questions of
 * sessions the user started stay with the user.
 */
export const answerQuestion = defineTool({
  name: "answer_question",
  description:
    "Answer a question one of this project's agent sessions asked (an open inbox item of kind 'question', named in a 'needs input' update), when its brief, your notes, the vision or a sensible default settles it. The agent gets the answer at once (or as its next message) and the inbox item closes as answered by you. Approvals, MCP servers' forms, and questions from sessions the user started, stay with the user.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    inboxItemId: z.string().min(1),
    answer: z
      .string()
      .min(1)
      .max(10_000)
      .describe("Your answer: an option's label or free text, with a short reason"),
  }),
  handler: async ({ inboxItemId, answer }, { services, projectId }) => {
    const item = services.inbox.find(inboxItemId);
    if (!item) throw new ToolError(`No inbox item ${inboxItemId}`);
    if (item.status !== "open") throw new ToolError(`That question was already ${item.status}`);
    if (item.kind !== "question") {
      throw new ToolError(
        item.kind === "approval"
          ? "Approvals stay with the user; you can only answer questions."
          : `Only questions can be answered here (this item is a ${item.kind}).`,
      );
    }
    if (!item.sessionId || !item.requestId) {
      throw new ToolError("This question belongs to no agent session");
    }
    const session = agentSessionOf(services, item.sessionId, projectId);
    if (!wakesPm(session)) {
      throw new ToolError("The user started that session and answers its questions themselves.");
    }
    const asked = questionItem(services.db, session.id, item.requestId);
    if (asked?.mcpServer) {
      throw new ToolError(
        `This is a form from the ${asked.mcpServer} MCP server: its answers go to that server as data, so like an approval it stays with the user. Leave it open; the agent waits for the user.`,
      );
    }
    // Every question of the item gets the answer (an `ask_user` question has one, `q1`).
    const ids = asked?.questions.map((q) => q.id) ?? ["q1"];
    const answers = Object.fromEntries(ids.map((id) => [id, [answer]]));
    await services.sessions.respond(
      session.id,
      { requestId: item.requestId, response: { kind: "answer", answers } },
      "pm",
    );
    return `Answered. ${session.title ?? session.purpose} (session ${session.id}) has your answer.`;
  },
});
