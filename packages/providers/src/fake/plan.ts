import type { AgentEvent, ItemOf, RuntimeResponse } from "@codeden/contracts";

/** What the plan script needs from the Fake session's turn. */
export interface FakeTurn {
  threadId: string;
  turnId: string;
  emit(event: AgentEvent): void;
  /** Yield (or wait `delayMs`); throws when the turn was interrupted. */
  step(): Promise<void>;
  nextId(kind: string): string;
  /** Wait for `respond(requestId)`; throws when the turn was interrupted. */
  waitFor(requestId: string): Promise<RuntimeResponse>;
}

/** The scripted plan for a prompt. */
export function fakePlan(prompt: string): string {
  return [
    "## Plan",
    "",
    `1. Read the request: ${prompt.trim() || "(empty)"}`,
    "2. Make the change",
    "3. Run the checks",
  ].join("\n");
}

/**
 * Plan mode in the Fake provider: propose a scripted plan and ask to implement it. Resolves
 * true when the plan was approved: the session leaves plan mode (`session.updated`) and the
 * turn goes on to do the work. Declined, the turn answers the feedback and ends, still
 * planning.
 */
export async function proposePlan(turn: FakeTurn, prompt: string): Promise<boolean> {
  const { threadId, turnId } = turn;
  await turn.step();
  const plan: ItemOf<"plan"> = {
    id: turn.nextId("item"),
    kind: "plan",
    status: "completed",
    text: fakePlan(prompt),
  };
  turn.emit({ type: "item.completed", threadId, turnId, item: plan });
  const requestId = turn.nextId("request");
  const base = {
    id: turn.nextId("item"),
    kind: "approval_request" as const,
    requestId,
    action: "plan" as const,
    title: "Approve the plan and start implementing",
    reason: "The agent finished planning",
    options: ["allow_once" as const, "deny" as const],
  };
  await turn.step();
  turn.emit({ type: "item.started", threadId, turnId, item: { ...base, status: "in_progress" } });
  const response = await turn.waitFor(requestId);
  const decision = response.kind === "approval" ? response.decision : "deny";
  const approved = decision !== "deny";
  turn.emit({
    type: "item.completed",
    threadId,
    turnId,
    item: {
      ...base,
      status: approved ? "completed" : "declined",
      decision,
      decidedBy: response.kind === "approval" ? (response.decidedBy ?? "user") : "user",
    },
  });
  if (approved) {
    turn.emit({ type: "session.updated", planMode: false });
    return true;
  }
  const feedback = response.kind === "approval" ? response.message?.trim() : undefined;
  turn.emit({
    type: "item.completed",
    threadId,
    turnId,
    item: {
      id: turn.nextId("item"),
      kind: "assistant_message",
      status: "completed",
      text: feedback ? `Still planning. I'll revise the plan: ${feedback}` : "Still planning.",
    },
  });
  return false;
}
