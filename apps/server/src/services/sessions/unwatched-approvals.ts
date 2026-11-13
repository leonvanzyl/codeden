import type { InboxItem, RawEventEnvelope, RespondRequest, Session } from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import { UNATTENDED_APPROVAL, unattendedSession } from "../factory/unattended";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "./repo";

/** How long an unwatched session's approval waits for the user before it is denied. */
export const UNWATCHED_APPROVAL_WAIT_MS = 30 * 60_000;

/** The denial an unwatched session gets when nobody answered in time. */
export function noAnswerDenial(waitMs: number): string {
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  return [
    `Not approved: nobody answered within ${minutes} minute${minutes === 1 ? "" : "s"}, and this session runs unattended (started by an automation, a project manager or the factory). Don't wait for it or try the same thing again.`,
    "- Find a way that stays inside your worktree, or skip this step. To publish your work, commit it and call `create_pull_request`.",
    "- If the task can't be finished without it, say what you needed and why in your final message, or call `finish` with outcome `blocked`, so the user sees it.",
  ].join("\n");
}

/**
 * True for sessions the user is unlikely to be watching: started by an automation, a PM or the
 * factory rather than by the user or the orchestrator they talk to.
 */
export function isUnwatched(session: Session): boolean {
  return (
    session.automationRunId !== null ||
    session.startedBy.kind === "automation" ||
    session.startedBy.kind === "pm"
  );
}

export interface UnwatchedApprovalsDeps {
  store: EventStore;
  repo: SessionRepo;
  projects: ProjectService;
  inbox: InboxService;
  /** Sends the decision to the agent (the session service's `respond`). */
  respond: (sessionId: string, req: RespondRequest) => Promise<void>;
  /** Default {@link UNWATCHED_APPROVAL_WAIT_MS}. */
  waitMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Approvals, and MCP servers' forms, nobody is there to answer (§10.1, §11.2). Nothing here ever
 * approves or fills in a form: an approval is denied, with guidance, and a form is withdrawn
 * (`cancel`, no data sent), so the agent carries on instead of waiting forever (fail closed).
 * - The PM and the factory's sessions in a dark factory are answered at once, as their questions
 *   are answered at once.
 * - Sessions started by an automation, a PM or the factory otherwise wait
 *   {@link UNWATCHED_APPROVAL_WAIT_MS} for the user. A scheduled run then finishes instead of
 *   blocking the next ones.
 * Sessions the user started wait for the user, however long. The agent's own questions are left
 * to the factory's rules (`answerProviderQuestion`).
 */
export class UnwatchedApprovals {
  private unsubscribe: (() => void) | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: UnwatchedApprovalsDeps) {}

  /** Watch new requests, and pick up the ones already open (a restart keeps their age). */
  start(): void {
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
    for (const item of this.deps.inbox.list()) {
      if (item.kind === "approval" || item.kind === "question") this.track(item);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "inbox.created" && e.type !== "inbox.updated") continue;
      const { item } = e.payload as { item: InboxItem };
      if (item.kind !== "approval" && item.kind !== "question") continue;
      if (item.status !== "open") {
        clearTimeout(this.timers.get(item.id));
        this.timers.delete(item.id);
      } else if (e.type === "inbox.created") {
        // After the current append: answering appends events of its own.
        setImmediate(() => this.track(item));
      }
    }
  }

  private track(item: InboxItem): void {
    const { sessionId, requestId } = item;
    if (item.status !== "open" || !sessionId || !requestId || this.timers.has(item.id)) return;
    if (item.kind === "question" && !this.isMcpForm(item)) return;
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session) return;
    if (unattendedSession(this.deps, sessionId)) {
      void this.close(item, UNATTENDED_APPROVAL);
      return;
    }
    if (!isUnwatched(session)) return;
    const waitMs = this.deps.waitMs ?? UNWATCHED_APPROVAL_WAIT_MS;
    const age = (this.deps.now?.() ?? Date.now()) - Date.parse(item.createdAt);
    const timer = setTimeout(
      () => {
        this.timers.delete(item.id);
        void this.close(item, noAnswerDenial(waitMs));
      },
      Math.max(0, waitMs - (Number.isFinite(age) ? age : 0)),
    );
    timer.unref?.();
    this.timers.set(item.id, timer);
  }

  /** A question that is an MCP server's form (its transcript item names the server). */
  private isMcpForm(item: InboxItem): boolean {
    if (!item.sessionId || !item.itemId) return false;
    const mirrored = this.deps.repo.item(item.sessionId, item.itemId)?.item;
    return mirrored?.kind === "user_question" && mirrored.mcpServer !== undefined;
  }

  /** Deny an approval with `message`, or withdraw a form: never approve, never invent data. */
  private async close(item: InboxItem, message: string): Promise<void> {
    if (this.deps.inbox.find(item.id)?.status !== "open") return;
    if (!item.sessionId || !item.requestId) return;
    try {
      await this.deps.respond(item.sessionId, {
        requestId: item.requestId,
        response:
          item.kind === "approval"
            ? { kind: "approval", decision: "deny", message, decidedBy: "policy" }
            : { kind: "cancel" },
      });
    } catch (error) {
      // The user answered first, or the session is gone.
      this.deps.log?.(`approvals: close ${item.id}: ${errorMessage(error)}`);
    }
  }
}
