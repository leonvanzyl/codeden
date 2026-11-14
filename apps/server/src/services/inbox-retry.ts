import type { InboxItem } from "@codeden/contracts";
import { runFailedAgain } from "../events/reducer/items";
import { badRequest, conflict, errorMessage, ServiceError } from "./errors";
import type { ProviderRunnable } from "./factory/availability";
import type { InboxService } from "./inbox-service";
import type { SessionRepo } from "./sessions/repo";
import type { SessionService } from "./sessions/session-service";

/** What the inbox's Retry sends to a failed session, as the user. */
export const RETRY_TEXT = "Retry the failed step.";

export interface InboxRetryDeps {
  inbox: InboxService;
  repo: SessionRepo;
  sessions: Pick<SessionService, "send">;
  /**
   * Whether the provider can run now, and the fix when it can't (§10.1). The server passes
   * `FactoryService.providerRunnableNow`: detected afresh before it says no.
   */
  runnable: (provider: string) => ProviderRunnable | Promise<ProviderRunnable>;
}

/**
 * Retry a `run_failed` item (§11.1): run its session again on its provider. Refused while that
 * provider can't run (not installed, too old, signed out, at its usage limit): Retry would only
 * fail the same way, so the answer says what fixes it instead. A retry that fails again updates
 * the same item (one more attempt, the latest error) and never adds a second one; one that
 * starts resolves it.
 */
export async function retryRunFailed(deps: InboxRetryDeps, id: string): Promise<InboxItem> {
  const item = deps.inbox.get(id);
  if (item.kind !== "run_failed" || !item.sessionId) {
    throw badRequest("Only a failed run can be retried", "not_retryable");
  }
  if (item.status !== "open") return item;
  const session = deps.repo.get(item.sessionId);
  const provider = await deps.runnable(session.provider);
  if (!provider.runnable) {
    throw conflict(provider.message ?? "The session's provider can't run", "provider_unavailable");
  }
  try {
    await deps.sessions.send(
      session.id,
      { input: { text: RETRY_TEXT, attachments: [] }, whenBusy: "queue" },
      "user",
    );
  } catch (error) {
    const message = errorMessage(error);
    // A provider that refused to open the session reported it already: its crash updated the item.
    const current = deps.inbox.find(id);
    if (current?.status === "open" && current.updatedAt === item.updatedAt) {
      deps.inbox.put(runFailedAgain(current, message, new Date().toISOString()));
    }
    throw new ServiceError(
      error instanceof ServiceError ? error.status : 502,
      "retry_failed",
      message,
    );
  }
  return deps.inbox.close(deps.inbox.get(id), "resolved", { note: "retry" });
}
