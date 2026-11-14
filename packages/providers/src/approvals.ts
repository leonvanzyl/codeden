import type { AgentEvent, ItemOf, RuntimeResponse } from "@codeden/contracts";
import { ProviderSessionError } from "./adapter";

/** Where an approval or question item lives. */
export interface ItemCtx {
  threadId: string;
  turnId: string;
}

type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

interface Pending {
  ctx: ItemCtx;
  item: Request;
  review: AnswerReview | undefined;
  resolve: (response: RuntimeResponse) => void;
}

/** How the asker takes a response, when it has rules of its own (an MCP server's form). */
export interface AnswerReview {
  /**
   * What doesn't fit in the response, if anything: `respond` rejects it with this message
   * (`invalid_answer`) and the request stays open, so nothing is sent until it fits.
   */
  problem?: (response: RuntimeResponse) => string | undefined;
  /** True when an answer turns the request down (a form's Decline): recorded as declined. */
  declines?: (response: RuntimeResponse) => boolean;
}

/**
 * Tracks `approval_request` / `user_question` items waiting on `ProviderSession.respond`.
 * Emits `item.started` when a request opens and `item.completed` with the decision when it is
 * answered, cancelled or aborted. Shared by all adapters.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get size(): number {
    return this.pending.size;
  }

  /** Open a request and wait for its response. Resolves `{ kind: "cancel" }` if aborted. */
  request(
    ctx: ItemCtx,
    item: Request,
    signal?: AbortSignal,
    review?: AnswerReview,
  ): Promise<RuntimeResponse> {
    return new Promise((resolve) => {
      const finish = (response: RuntimeResponse) => {
        if (!this.pending.delete(item.requestId)) return;
        signal?.removeEventListener("abort", onAbort);
        const declined = response.kind === "answer" && review?.declines?.(response) === true;
        this.emit({ type: "item.completed", ...ctx, item: completed(item, response, declined) });
        resolve(response);
      };
      const onAbort = () => finish({ kind: "cancel" });
      this.pending.set(item.requestId, { ctx, item, review, resolve: finish });
      this.emit({ type: "item.started", ...ctx, item });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Record a request CodeDen decided itself (`decidedBy: "policy"`): it shows in the transcript
   * as decided, and nothing waits on it.
   */
  record(ctx: ItemCtx, item: Request): void {
    this.emit({ type: "item.completed", ...ctx, item });
  }

  /**
   * Answer a pending request. Throws `unknown_request` for unknown ids, and `invalid_answer`
   * (leaving the request open) for a response its {@link AnswerReview} finds a problem with.
   */
  respond(requestId: string, response: RuntimeResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new ProviderSessionError("unknown_request", `Unknown request ${requestId}`);
    const problem = pending.review?.problem?.(response);
    if (problem) throw new ProviderSessionError("invalid_answer", problem);
    pending.resolve(response);
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Cancel every pending request (interrupt, close). */
  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.resolve({ kind: "cancel" });
  }
}

function completed(item: Request, response: RuntimeResponse, declined: boolean): Request {
  if (item.kind === "approval_request") {
    if (response.kind === "approval") {
      return {
        ...item,
        status: response.decision === "deny" ? "declined" : "completed",
        decision: response.decision,
        decidedBy: response.decidedBy ?? "user",
      };
    }
    return { ...item, status: "cancelled" };
  }
  if (response.kind === "answer") {
    return { ...item, status: declined ? "declined" : "completed", answers: response.answers };
  }
  return { ...item, status: "cancelled" };
}
