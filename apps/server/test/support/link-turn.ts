import type { Session } from "@codeden/contracts";
import type { RunningServer } from "../../src";
import { sampleSession } from "../helpers";

/**
 * A Fake session placed on `runnerId`, started with a prompt of `words` words: the Fake turn
 * then streams for a while (one delta per word), long enough to cut the link mid-turn.
 */
export async function startStreamingTurn(
  server: RunningServer,
  id: string,
  runnerId: string,
  words = 300,
): Promise<void> {
  const prompt = Array.from({ length: words }, (_, i) => `w${i}`).join(" ");
  const session: Session = { ...sampleSession, id, status: "queued", runnerId };
  const { sessionRepo, sessions } = server.services;
  sessionRepo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
    pending: { input: { text: prompt, attachments: [] }, workspace: { mode: "worktree" } },
  });
  sessions.startQueued(session);
  await sessions.launching.get(id);
}

/** How many stored events of `type` the session has. */
export function countEvents(server: RunningServer, sessionId: string, type: string): number {
  return server.store.listAfter(0, 100_000, [sessionId]).filter((e) => e.type === type).length;
}

interface Delta {
  itemId: string;
  delta: { type: string; text?: string };
}
type ItemPayload = { item?: { id: string; kind?: string; text?: string } };

/**
 * The session's assistant reply as stored: its streamed deltas joined, and the completed
 * item's text. Equal when every delta was stored exactly once.
 */
export function storedReply(
  server: RunningServer,
  sessionId: string,
): { streamed: string; completed: string | undefined } {
  const stored = server.store.listAfter(0, 100_000, [sessionId]);
  const item = stored
    .filter((e) => e.type === "agent.item.completed")
    .map((e) => (e.payload as ItemPayload).item)
    .find((i) => i?.kind === "assistant_message");
  const streamed = stored
    .filter((e) => e.type === "agent.item.delta" && (e.payload as Delta).itemId === item?.id)
    .map((e) => (e.payload as Delta).delta.text ?? "")
    .join("");
  return { streamed, completed: item?.text };
}
