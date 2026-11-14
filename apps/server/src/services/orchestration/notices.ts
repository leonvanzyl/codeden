import {
  type AgentEventOf,
  type AutomationRun,
  type InboxItem,
  inboxAttempts,
  type ListNoticesQuery,
  type Notice,
  type NoticeTarget,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { notices } from "../../db/schema-orchestration";
import type { EventStore } from "../../events/store";
import type { SessionRepo } from "../sessions/repo";
import { clipKeepingEnd } from "./digest";

/** A notice before it is stored (`deliveredAt` is set by delivery). */
export type NoticeDraft = Notice extends infer N
  ? N extends Notice
    ? Omit<N, "createdAt" | "deliveredAt">
    : never
  : never;

/** Notices and whether each should wake its target. */
export interface DerivedNotice {
  notice: NoticeDraft;
  wake: boolean;
}

/** What `deriveNotices` needs to look up while reading events. */
export interface NoticeLookup {
  session(id: string): Session | undefined;
  /** Text of the final assistant message of a turn. */
  finalMessage(sessionId: string, turnId: string): string | null;
  /** The MCP server whose form a transcript item is (an elicitation), if it is one. */
  mcpServer?(sessionId: string, itemId: string): string | undefined;
}

/** {@link NoticeLookup.mcpServer} over the session transcripts. */
export function formServerOf(
  repo: Pick<SessionRepo, "item">,
  sessionId: string,
  itemId: string,
): string | undefined {
  const item = repo.item(sessionId, itemId)?.item;
  return item?.kind === "user_question" ? item.mcpServer : undefined;
}

const clip = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

/**
 * Work started by the PM, the orchestrator or an automation wakes the PM; sessions the user
 * started (and is watching) only produce notices that show up in the PM's next digest.
 */
export function wakesPm(session: Session): boolean {
  return session.startedBy.kind !== "user" || session.parentSessionId !== null;
}

/** Work a PM started for a request the orchestrator passed on (`startedBy.reportTo`). */
function reportsToOrchestrator(session: Session): boolean {
  return session.startedBy.reportTo === "orchestrator";
}

/** A session notice, copied for the orchestrator so the result reaches whoever asked (§8.2). */
function forOrchestrator(notice: NoticeDraft, id: string): DerivedNotice {
  return { wake: true, notice: { ...notice, id, target: "orchestrator" } };
}

/** The id of an opened PR's notice: the same whether it came from the session or GitHub sync. */
export function prOpenedNoticeId(projectId: string, number: number): string {
  return `pr.opened:${projectId}:${number}`;
}

/** An open `run_failed` item updated by a further failure of its session (`attempts` > 1). */
export function isRepeatFailure(item: InboxItem): boolean {
  return item.kind === "run_failed" && item.status === "open" && inboxAttempts(item) > 1;
}

/**
 * One failure of a run: the item, and from its second failure on the attempt, so every failure
 * gets its own notice while replays of the same one never duplicate it.
 */
function failureKey(item: InboxItem): string {
  const attempts = inboxAttempts(item);
  return attempts > 1 ? `${item.id}:${attempts}` : item.id;
}

function workRef(s: Session) {
  return { sessionId: s.id, workKey: s.workKey, purpose: s.purpose, startedBy: s.startedBy };
}

/**
 * Typed notices for a batch of committed events (§8.2 step 4). Pure apart from the lookups.
 * Only agent sessions inside a project produce notices; ids are derived from the source so
 * replays and repeats never create duplicates.
 */
export function deriveNotices(events: RawEventEnvelope[], lookup: NoticeLookup): DerivedNotice[] {
  const out: DerivedNotice[] = [];
  const agentSession = (id: string | null | undefined) => {
    const s = id ? lookup.session(id) : undefined;
    return s && s.role === "agent" && s.projectId ? s : undefined;
  };
  for (const e of events) {
    if (e.type === "agent.turn.completed") {
      const event = e.payload as AgentEventOf<"turn.completed">;
      const s = agentSession(e.sessionId);
      if (!s || s.rootThreadId !== event.threadId) continue;
      const final = lookup.finalMessage(s.id, event.turnId);
      const finished: NoticeDraft = {
        id: `session.finished:${s.id}:${event.turnId}`,
        type: "session.finished",
        projectId: s.projectId,
        target: "pm",
        sessionId: s.id,
        title: `Finished: ${s.title ?? s.purpose}`,
        data: {
          ...workRef(s),
          summary: s.result?.summary ?? (final ? clipKeepingEnd(final) : null),
          outcome: s.result?.outcome ?? null,
        },
      };
      out.push({ wake: wakesPm(s), notice: finished });
      // Once per `finish` call: a turn without a result is the PM's business only.
      if (reportsToOrchestrator(s) && s.result) {
        out.push(forOrchestrator(finished, `session.finished:orchestrator:${s.id}:${s.result.at}`));
      }
    } else if (e.type === "inbox.created" || e.type === "inbox.updated") {
      const { item } = e.payload as { item: InboxItem };
      // A session that fails again updates its open `run_failed` item in place (one item per
      // run): each new failure still reaches the PM, the orchestrator and automations.
      if (e.type === "inbox.updated" && !isRepeatFailure(item)) continue;
      const s = agentSession(item.sessionId);
      if (!s) continue;
      if (item.kind === "question" || item.kind === "approval") {
        const mcpServer =
          item.kind === "question" && item.itemId
            ? lookup.mcpServer?.(s.id, item.itemId)
            : undefined;
        out.push({
          wake: wakesPm(s),
          notice: {
            id: `session.needs_input:${item.id}`,
            type: "session.needs_input",
            projectId: s.projectId,
            target: "pm",
            sessionId: s.id,
            title: `Needs input: ${s.title ?? s.purpose}`,
            data: {
              ...workRef(s),
              inboxItemId: item.id,
              kind: item.kind,
              question: item.title,
              ...(mcpServer ? { mcpServer } : {}),
            },
          },
        });
      } else if (item.kind === "run_failed") {
        const failed: NoticeDraft = {
          id: `session.failed:${failureKey(item)}`,
          type: "session.failed",
          projectId: s.projectId,
          target: "pm",
          sessionId: s.id,
          title: `Failed: ${s.title ?? s.purpose}`,
          data: { ...workRef(s), error: clip(item.body ?? item.title) },
        };
        out.push({ wake: wakesPm(s), notice: failed });
        if (reportsToOrchestrator(s)) {
          out.push(forOrchestrator(failed, `session.failed:orchestrator:${failureKey(item)}`));
        }
      }
    } else if (e.type === "session.updated") {
      const { session } = e.payload as { session: Session };
      if (session.role !== "agent" || !session.projectId || !session.pr) continue;
      out.push({
        wake: wakesPm(session),
        notice: {
          id: prOpenedNoticeId(session.projectId, session.pr.number),
          type: "pr.opened",
          projectId: session.projectId,
          target: "pm",
          sessionId: session.id,
          title: `PR #${session.pr.number} opened: ${session.pr.title ?? session.purpose}`,
          data: { sessionId: session.id, pr: session.pr },
        },
      });
    } else if (e.type === "automation_run.updated") {
      const { run } = e.payload as { run: AutomationRun };
      if (run.status !== "skipped" || !run.projectId) continue;
      out.push({
        wake: true,
        notice: {
          id: `automation.skipped:${run.id}`,
          type: "automation.skipped",
          projectId: run.projectId,
          target: "pm",
          sessionId: run.sessionId,
          title: `Automation skipped: ${run.purpose}`,
          data: {
            automationRunId: run.id,
            automationId: run.automationId,
            workKey: run.workKey,
            purpose: run.purpose,
            reason: run.skipReason ?? "skipped",
          },
        },
      });
    }
  }
  return out;
}

/** Stored notices (§8.2): created through `notice.created`, delivered through `notice.delivered`. */
export class NoticeStore {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
  ) {}

  /** Store a notice unless one with the same id exists. Returns the stored notice, if new. */
  create(draft: NoticeDraft): Notice | undefined {
    if (this.db.select({ id: notices.id }).from(notices).where(eq(notices.id, draft.id)).get()) {
      return undefined;
    }
    const notice = { ...draft, createdAt: new Date().toISOString(), deliveredAt: null } as Notice;
    this.store.append([{ type: "notice.created", sessionId: null, payload: { notice } }]);
    return notice;
  }

  list(query: Partial<ListNoticesQuery> = {}): Notice[] {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(notices.projectId, query.projectId));
    if (query.target) conditions.push(eq(notices.target, query.target));
    return this.db
      .select()
      .from(notices)
      .where(and(...conditions))
      .orderBy(desc(notices.createdAt))
      .limit(query.limit ?? 100)
      .all()
      .map((r) => r.notice);
  }

  /**
   * Undelivered notices for a target, oldest first. `projectId` null = the orchestrator. A
   * scheduled wake-up counts once it is due.
   */
  undelivered(target: NoticeTarget, projectId: string | null): Notice[] {
    return this.db
      .select()
      .from(notices)
      .where(
        and(
          eq(notices.target, target),
          isNull(notices.deliveredAt),
          projectId === null ? undefined : eq(notices.projectId, projectId),
          or(isNull(notices.notBefore), lte(notices.notBefore, new Date().toISOString())),
        ),
      )
      .orderBy(notices.createdAt)
      .limit(50)
      .all()
      .map((r) => r.notice);
  }

  /** A target's scheduled wake-ups still to deliver (due or not), soonest first. */
  scheduled(target: NoticeTarget, projectId: string | null): Notice[] {
    return this.db
      .select()
      .from(notices)
      .where(
        and(
          eq(notices.type, "reminder"),
          eq(notices.target, target),
          isNull(notices.deliveredAt),
          projectId === null ? isNull(notices.projectId) : eq(notices.projectId, projectId),
        ),
      )
      .orderBy(asc(notices.notBefore))
      .all()
      .map((r) => r.notice);
  }

  /** Undelivered notices held back until a time: the due ones, or the soonest still ahead. */
  heldBack(due: boolean): Notice[] {
    const now = new Date().toISOString();
    return this.db
      .select()
      .from(notices)
      .where(
        and(
          isNull(notices.deliveredAt),
          due ? lte(notices.notBefore, now) : gt(notices.notBefore, now),
        ),
      )
      .orderBy(asc(notices.notBefore))
      .limit(due ? 200 : 1)
      .all()
      .map((r) => r.notice);
  }

  /** Notices of the given types for a project since `since`, newest first. */
  recent(projectId: string, types: Notice["type"][], since: string, limit = 5): Notice[] {
    return this.db
      .select()
      .from(notices)
      .where(
        and(
          eq(notices.projectId, projectId),
          inArray(notices.type, types),
          gte(notices.createdAt, since),
        ),
      )
      .orderBy(desc(notices.createdAt))
      .limit(limit)
      .all()
      .map((r) => r.notice);
  }

  markDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    this.store.append([
      {
        type: "notice.delivered",
        sessionId: null,
        payload: { noticeIds: ids, at: new Date().toISOString() },
      },
    ]);
  }

  /** Back to undelivered: the turn that carried them failed, so the next wake carries them. */
  markReturned(ids: string[]): void {
    if (ids.length === 0) return;
    this.store.append([
      {
        type: "notice.returned",
        sessionId: null,
        payload: { noticeIds: ids, at: new Date().toISOString() },
      },
    ]);
  }
}
