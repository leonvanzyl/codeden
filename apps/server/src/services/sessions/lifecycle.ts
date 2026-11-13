import {
  type AgentEventOf,
  agentEventToNewEvent,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord } from "../../db/rows";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import type { McpTokenStore } from "../../mcp/tokens";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { UtilityService } from "../utility";
import { findConflicts } from "./conflicts";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

export interface LifecycleDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  sessions: SessionService;
  settings: SettingsStore;
  utility: UtilityService;
  tokens: McpTokenStore;
  log?: (message: string) => void;
}

/**
 * Session statuses after which its MCP tokens are revoked (§8.3). Not `failed`: a failed turn
 * leaves the provider process running with its token, and the next message reaches that same
 * process; a session whose process is gone is resumed with a freshly minted token, and the
 * old one is revoked once the runner has started it (`SessionLauncher`).
 */
const ENDED = new Set(["stopped", "completed"]);

/**
 * Reacts to committed events: starts queued sessions whose blockers finished (§8.4 `wait`),
 * sends queued messages when a session goes idle, and runs utility-model hooks after a root
 * turn completes. Work is deferred so it never appends inside a store notification.
 */
export class SessionLifecycle {
  private drainScheduled = false;
  /** Sessions whose title is being generated. */
  private readonly titling = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: LifecycleDeps) {}

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    this.scheduleDrain();
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Start every queued session that no longer conflicts with earlier work. */
  drainQueue(): void {
    const queued = this.deps.repo.queued();
    queued.forEach((session, index) => {
      const later = new Set(queued.slice(index + 1).map((s) => s.id));
      const others = this.deps.repo
        .activeWork(session.projectId)
        .filter((w) => w.id !== session.id && !later.has(w.id));
      const blockers = findConflicts({ workKey: session.workKey, scope: session.scope }, others);
      if (blockers.length === 0) this.deps.sessions.startQueued(session);
    });
  }

  private onEvents(events: RawEventEnvelope[]): void {
    let sessionsChanged = false;
    for (const e of events) {
      if (e.type === "session.created" || e.type === "session.updated") {
        sessionsChanged = true;
        const { session } = e.payload as { session: Session };
        if (ENDED.has(session.status)) this.deps.tokens.revokeSession(session.id);
        const settled = session.status === "idle" || session.status === "failed";
        if (settled && this.deps.sessions.hasOutbox(session.id)) {
          setImmediate(() => void this.deps.sessions.flushOutbox(session.id));
        }
      } else if (
        (e.type === "agent.item.started" || e.type === "agent.item.completed") &&
        e.sessionId
      ) {
        const { item } = e.payload as AgentEventOf<"item.started">;
        if (item.kind === "user_message" && item.input.text.trim()) {
          const sessionId = e.sessionId;
          const text = item.input.text;
          setImmediate(() => void this.titleFromFirstMessage(sessionId, text));
        }
      } else if (e.type === "agent.turn.completed" && e.sessionId) {
        const sessionId = e.sessionId;
        const event = e.payload as AgentEventOf<"turn.completed">;
        setImmediate(() => void this.afterTurn(sessionId, event));
      }
    }
    if (sessionsChanged) this.scheduleDrain();
  }

  /** Name an untitled session after its first user message (§7.4). Never throws. */
  private async titleFromFirstMessage(sessionId: string, text: string): Promise<void> {
    if (this.titling.has(sessionId)) return;
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session || session.title) return;
    this.titling.add(sessionId);
    try {
      const title = await this.deps.utility.sessionTitle({
        session,
        finalMessage: null,
        firstMessage: text,
      });
      if (title) this.deps.repo.update(sessionId, (s) => (s.title ? s : { ...s, title }));
    } catch (error) {
      this.deps.log?.(`utility title: ${errorMessage(error)}`);
    } finally {
      this.titling.delete(sessionId);
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      try {
        this.drainQueue();
      } catch (error) {
        this.deps.log?.(`queue: ${errorMessage(error)}`);
      }
    });
  }

  /** Utility-model hooks (§7.4, §7.5); no-ops with the default `UtilityService`. */
  private async afterTurn(sessionId: string, event: AgentEventOf<"turn.completed">): Promise<void> {
    try {
      const session = this.deps.repo.find(sessionId)?.session;
      if (!session || session.rootThreadId !== event.threadId) return;
      const settings = this.deps.settings.get();
      const turnItems = this.deps.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), eq(items.turnId, event.turnId)))
        .orderBy(desc(items.position))
        .all()
        .map(rowToItemRecord);
      const final = turnItems.find((r) => r.item.kind === "assistant_message")?.item;
      const changedFiles = turnItems.flatMap((r) =>
        r.item.kind === "tool_call" && r.item.toolKind === "file_edit"
          ? r.item.changes.map((c) => c.path)
          : [],
      );
      const first = this.deps.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), eq(items.kind, "user_message")))
        .orderBy(asc(items.createdAt))
        .limit(1)
        .get();
      const ctx = {
        session,
        finalMessage: final?.kind === "assistant_message" ? final.text : null,
        firstMessage: first?.data.kind === "user_message" ? first.data.input.text : null,
        changedFiles: [...new Set(changedFiles)],
      };

      if (
        !session.title &&
        !this.titling.has(sessionId) &&
        settings.utilityModel.jobs.sessionTitles
      ) {
        const title = await this.deps.utility.sessionTitle(ctx);
        if (title) this.deps.repo.update(sessionId, (s) => (s.title ? s : { ...s, title }));
      }
      const hasFollowups = turnItems.some((r) => r.item.kind === "followups");
      if (!hasFollowups && settings.followups.enabled && settings.utilityModel.jobs.followups) {
        const suggestions = await this.deps.utility.suggestFollowups(ctx);
        if (suggestions && suggestions.length > 0) {
          this.deps.store.append([
            agentEventToNewEvent(sessionId, {
              type: "item.completed",
              threadId: event.threadId,
              turnId: event.turnId,
              item: {
                id: `followups-${event.turnId}`,
                kind: "followups",
                status: "completed",
                source: "utility",
                suggestions: suggestions.slice(0, 4),
              },
            }),
          ]);
        }
      }
    } catch (error) {
      this.deps.log?.(`utility hooks: ${errorMessage(error)}`);
    }
  }
}
