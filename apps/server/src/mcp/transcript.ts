import { type Artifact, agentEventToNewEvent, type Item } from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import { turns } from "../db/schema";
import { turnsNewestFirst } from "../db/turn-order";
import { sharedArtifactNotice } from "../services/artifacts";
import type { AppServices } from "../services/container";
import { ToolError } from "./define";

/** The root-thread turn a tool call belongs to (the running one, else the latest). */
export interface TurnRef {
  threadId: string;
  turnId: string;
}

export function currentTurn(services: AppServices, sessionId: string): TurnRef {
  const session = services.sessionRepo.get(sessionId);
  const threadId = session.rootThreadId;
  if (!threadId) throw new ToolError("The session has no conversation yet");
  const rows = services.db
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.threadId, threadId)))
    .orderBy(...turnsNewestFirst)
    .limit(5)
    .all();
  const turn = rows.find((t) => t.status === "running") ?? rows[0];
  if (!turn) throw new ToolError("The session has no turn to attach this to");
  return { threadId, turnId: turn.id };
}

/** Append (or replace, by item id) an item in a turn through the event log. */
export function putTurnItem(
  services: AppServices,
  sessionId: string,
  turn: TurnRef,
  item: Item,
): void {
  services.store.append([
    agentEventToNewEvent(sessionId, {
      type: item.status === "in_progress" ? "item.started" : "item.completed",
      threadId: turn.threadId,
      turnId: turn.turnId,
      item,
    }),
  ]);
}

/** Show a stored artifact inline in the session's current turn (`notice`, `shared_artifact`). */
export function postSharedArtifact(
  services: AppServices,
  sessionId: string,
  artifact: Artifact,
  caption?: string,
): void {
  const turn = currentTurn(services, sessionId);
  putTurnItem(services, sessionId, turn, sharedArtifactNotice(artifact, caption));
}
