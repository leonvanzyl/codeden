import type { ProviderInfo, QueuedMessage, SendQueuedNowResponse } from "@codeden/contracts";
import { badRequest, conflict, notFound } from "../errors";
import { type ArtifactLookup, clientInput } from "./client-items";
import type { Outbox } from "./outbox";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

export interface QueueServiceDeps {
  outbox: Outbox;
  repo: SessionRepo;
  sessions: SessionService;
  artifacts: ArtifactLookup;
  /** The providers loaded by the runner that hosts this session. */
  providers: (sessionId: string) => ProviderInfo[];
}

const BUSY = new Set(["running", "waiting"]);

/**
 * The queued-message tray (`/api/sessions/:id/queue`): list, edit, delete and send-now.
 * Messages are taken from the `Outbox` synchronously, so a request racing delivery either
 * wins or answers 409 `already_sent`; it never acts on a message that is being delivered.
 */
export class QueueService {
  constructor(private readonly deps: QueueServiceDeps) {}

  /** A session's queued messages as the browser sees them, next first. */
  list(sessionId: string): QueuedMessage[] {
    this.deps.repo.get(sessionId);
    return this.deps.outbox.list(sessionId).map((m) => this.present(m));
  }

  edit(sessionId: string, messageId: string, text: string): QueuedMessage {
    const message = this.require(sessionId, messageId);
    if (!text.trim() && message.input.attachments.length === 0) {
      throw badRequest("A queued message needs text or an attachment", "empty_message");
    }
    return this.present(this.deps.outbox.edit(message, text));
  }

  delete(sessionId: string, messageId: string): void {
    this.deps.outbox.remove(this.require(sessionId, messageId), "deleted");
  }

  /**
   * Steer the running turn with a queued message, ahead of its place. Only a running turn
   * can take it (409 `no_turn` otherwise; the queue sends it next, in order), and only on a
   * provider that can steer. If the steer fails the message goes back in its place.
   */
  async sendNow(sessionId: string, messageId: string): Promise<SendQueuedNowResponse> {
    const message = this.require(sessionId, messageId);
    const session = this.deps.repo.get(sessionId);
    if (!BUSY.has(session.status)) {
      // Nudge delivery so an idle session with a waiting queue sends its next message, in order.
      void this.deps.sessions.flushOutbox(sessionId).catch(() => undefined);
      throw conflict("No turn is running: the queue sends this message next", "no_turn");
    }
    const canSteer = this.deps.providers(sessionId).find((p) => p.id === session.provider)
      ?.capabilities.steer;
    if (!canSteer) throw conflict("This provider cannot steer a running turn", "unsupported");
    // Taken out before anything is awaited: delivery can no longer pick it up.
    this.deps.outbox.remove(message, "sent");
    try {
      await this.deps.sessions.steer(sessionId, message.input);
      return { status: "steered" };
    } catch (error) {
      this.deps.outbox.restore(message);
      void this.deps.sessions.flushOutbox(sessionId).catch(() => undefined);
      throw error;
    }
  }

  /** The queued message, or 409 `already_sent` / 404 when it is no longer queued. */
  private require(sessionId: string, messageId: string): QueuedMessage {
    this.deps.repo.get(sessionId);
    const message = this.deps.outbox.get(sessionId, messageId);
    if (message) return message;
    const reason = this.deps.outbox.dequeuedReason(sessionId, messageId);
    if (reason === "sent") throw conflict("This message was already sent", "already_sent");
    if (reason) throw conflict("This message is no longer queued", "no_longer_queued");
    throw notFound("No such queued message", "queued_message_not_found");
  }

  private present(message: QueuedMessage): QueuedMessage {
    return { ...message, input: clientInput(message.input, this.deps.artifacts) };
  }
}
