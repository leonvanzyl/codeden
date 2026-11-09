import { z } from "zod";
import { UNATTENDED_ANSWER } from "../../services/factory/unattended";
import { defineTool } from "../define";
import { currentTurn } from "../transcript";

/**
 * `ask_user` (§8.3, §11.1): a question for the user, shown in the transcript and the inbox.
 * Blocks for a few minutes; unanswered questions stay in the inbox and the answer arrives
 * later as a new message (see `QuestionBroker`). In a dark factory the PM and the factory's
 * agents are unattended: they get {@link UNATTENDED_ANSWER} at once and decide themselves.
 */
export const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user a question when you cannot proceed without their decision. Offer options when there are clear choices. The call waits a few minutes for an answer. If it returns 'pending', do not wait or ask again: finish whatever does not depend on the answer, then end your turn; the answer will arrive as your next message.",
  roles: ["agent", "pm"],
  scope: "session",
  alwaysLoad: true,
  input: z.object({
    question: z.string().min(1).max(2_000),
    header: z.string().max(40).optional().describe("A few words summarising the question"),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(100),
          description: z.string().max(300).optional(),
        }),
      )
      .max(6)
      .optional(),
    multiSelect: z.boolean().optional(),
  }),
  handler: async (input, { services, sessionId, signal }) => {
    if (services.factory.isUnattended(sessionId)) return UNATTENDED_ANSWER;
    const turn = currentTurn(services, sessionId);
    const outcome = await services.questions.ask(
      sessionId,
      turn,
      {
        question: input.question,
        header: input.header,
        options: input.options ?? [],
        multiSelect: input.multiSelect ?? false,
        allowFreeText: true,
      },
      signal,
    );
    if (outcome.status === "answered") return `The user answered:\n${outcome.text}`;
    if (outcome.status === "dismissed") return "The user dismissed the question without answering.";
    return "pending: the question is waiting in the user's inbox. Do not wait for it. Finish what you can without the answer, then end your turn; the answer will arrive as your next message.";
  },
});
