import type { Item, RuntimeResponse } from "@codeden/contracts";
import { cmd } from "./fixtures/item-builders";
import { Script, streamSteps, uid } from "./live";
import type { MockWorld } from "./world";

/** Find the transcript item waiting on `requestId`. */
function findRequest(world: MockWorld, sessionId: string, requestId: string) {
  const t = world.transcript(sessionId);
  for (const entry of Object.values(t.items)) {
    const it = entry.item;
    if (
      (it.kind === "approval_request" || it.kind === "user_question") &&
      it.requestId === requestId
    ) {
      return entry;
    }
  }
  return undefined;
}

function resolveInboxFor(world: MockWorld, requestId: string, action: string) {
  const item = world.snapshot.inbox.find((i) => i.requestId === requestId && i.status === "open");
  if (!item) return;
  const now = new Date().toISOString();
  world.emitDomain({
    type: "inbox.updated",
    sessionId: null,
    payload: {
      item: {
        ...item,
        status: "resolved",
        resolvedAt: now,
        updatedAt: now,
        resolution: { action },
      },
    },
  });
}

/** Apply a response to an approval or question and play the agent's continuation. */
export function respond(
  world: MockWorld,
  sessionId: string,
  requestId: string,
  response: RuntimeResponse,
): Script | null {
  const entry = findRequest(world, sessionId, requestId);
  if (!entry) return null;
  const ids = { sessionId, threadId: entry.threadId, turnId: entry.turnId };
  const complete = (item: Item) =>
    world.emitAgent(sessionId, { type: "item.completed", ...ids, item });
  const start = (item: Item) => world.emitAgent(sessionId, { type: "item.started", ...ids, item });
  const replyId = uid("a");
  const it = entry.item;

  let reply = "";
  const pre: { wait: number; run: () => void }[] = [];

  if (it.kind === "approval_request" && response.kind === "approval") {
    const denied = response.decision === "deny";
    complete({
      ...it,
      status: denied ? "declined" : "completed",
      decision: response.decision,
      decidedBy: "user",
    });
    resolveInboxFor(world, requestId, response.decision);
    if (it.toolCallItemId) {
      const gated = world.item(sessionId, it.toolCallItemId);
      if (gated?.kind === "tool_call" && gated.toolKind === "command") {
        pre.push({
          wait: 500,
          run: () =>
            complete(
              denied
                ? { ...gated, status: "declined" }
                : cmd(
                    gated.id,
                    gated.command,
                    "To github.com:hearth-co/storefront.git\n + 4e1f2c9...b77d0a1 codeden/fix-checkout-flake -> codeden/fix-checkout-flake (forced update)",
                    0,
                    1300,
                  ),
            ),
        });
      }
    }
    reply = denied
      ? "Understood — I won't force push. I'll push the fixups as normal commits instead, so the branch history stays intact."
      : "Pushed. The reviewer approved the change, so I opened **PR #59 · Fix flaky checkout total** with the 50-run result attached as evidence. It links #142 with `Fixes #142`.";
  } else if (it.kind === "user_question" && response.kind === "answer") {
    complete({ ...it, status: "completed", answers: response.answers });
    resolveInboxFor(world, requestId, "answered");
    const picked = Object.values(response.answers).flat().join(", ");
    reply = `Thanks — going with **${picked || "your answer"}**. Implementing it now with tests for the retry schedule.`;
  } else if (response.kind === "cancel") {
    complete({ ...it, status: "cancelled" });
    return null;
  } else {
    return null;
  }

  world.updateSession(sessionId, { status: "running" });
  return new Script([
    ...pre,
    {
      wait: 400,
      run: () => start({ id: replyId, kind: "assistant_message", status: "in_progress", text: "" }),
    },
    ...streamSteps(world, { ...ids, itemId: replyId }, reply),
    {
      wait: 300,
      run: () => {
        complete({ id: replyId, kind: "assistant_message", status: "completed", text: reply });
        complete({
          id: uid("f"),
          kind: "followups",
          status: "completed",
          source: "agent",
          suggestions: [
            { label: "Summarise the PR", prompt: "Summarise the pull request for a reviewer." },
            { label: "Watch CI", prompt: "Watch CI on the PR and fix anything that fails." },
          ],
        });
        world.emitAgent(sessionId, {
          type: "turn.completed",
          ...ids,
          forkPoint: ids.turnId,
          stopReason: "end_turn",
        });
        world.updateSession(sessionId, { status: "idle" });
      },
    },
  ]);
}
