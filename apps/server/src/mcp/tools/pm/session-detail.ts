import { z } from "zod";
import { defineTool } from "../../define";
import { agentSessionOf, compactSession } from "../shared/helpers";
import { lastAssistantMessage, questionItem } from "../shared/session-items";

/** Longest last message returned; longer ones keep their end, where questions usually are. */
const MESSAGE_LIMIT = 8_000;

/**
 * `get_session` (§8.4): one agent session in detail, so the PM can act on what it said or asked
 * without the user relaying it: its last message in full, what it waits on (with inbox ids, for
 * `answer_question`) and its result.
 */
export const getSession = defineTool({
  name: "get_session",
  description:
    "One of this project's agent sessions in detail: status, progress and result, its last message in full, and the questions and approvals it is waiting on with their inbox ids (answer questions with answer_question; approvals and MCP servers' forms, marked with `mcpServer`, wait for the user). Takes the full session id or a unique prefix of at least 6 characters, as updates and the status digest show them.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ sessionId: z.string().min(1) }),
  handler: async ({ sessionId }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    const last = lastAssistantMessage(services.db, session);
    const waitingOn = services.inbox
      .list({ sessionId: session.id })
      .filter((i) => i.kind === "question" || i.kind === "approval")
      .map((i) => {
        const asked = i.requestId ? questionItem(services.db, session.id, i.requestId) : undefined;
        return {
          inboxItemId: i.id,
          kind: i.kind,
          title: i.title,
          body: i.body,
          ...(asked
            ? {
                questions: asked.questions.map((q) => ({
                  question: q.question,
                  options: q.options.map((o) => o.label),
                })),
                // An MCP server's form: its answers are data for that server, so the user's.
                ...(asked.mcpServer ? { mcpServer: asked.mcpServer } : {}),
              }
            : {}),
        };
      });
    return {
      session: compactSession(session),
      lastMessage:
        last && last.length > MESSAGE_LIMIT ? `…${last.slice(-MESSAGE_LIMIT)}` : (last ?? null),
      waitingOn,
    };
  },
});
