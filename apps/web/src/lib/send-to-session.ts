import type { Session, UserInputInit } from "@codeden/contracts";
import type { CodeDenClient, SendMode } from "@/lib/api";

/**
 * Send a message to a session the way the composer does. Agent sessions take it directly
 * (sent now, or queued behind a running turn); orchestrator and PM sessions go through
 * orchestration, which adds the fresh status digest (§8.4).
 */
export async function sendToSession(
  client: CodeDenClient,
  session: Session,
  input: UserInputInit,
  mode: SendMode,
): Promise<void> {
  if (session.role === "agent") return client.sendMessage(session.id, input, mode);
  await client.orchestration.send(
    session.role,
    session.projectId,
    input,
    mode === "steer" ? "steer" : "queue",
  );
}
