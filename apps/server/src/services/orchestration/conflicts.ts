import { randomUUID } from "node:crypto";
import {
  ConflictDecision,
  ConflictRecord,
  type InboxItem,
  type JsonValue,
  type ListConflictsQuery,
  type ResolveConflictRequest,
  type ResolveConflictResponse,
  StartSessionRequest,
  type StartSessionResponse,
  type WorkSummary,
} from "@codeden/contracts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conflicts } from "../../db/schema-orchestration";
import type { EventStore } from "../../events/store";
import type { ArtifactService } from "../artifacts";
import { badRequest, conflict as conflictError, notFound } from "../errors";
import type { InboxService } from "../inbox-service";
import { derivePurpose, deriveWorkKey } from "../sessions/conflicts";
import type { SessionService } from "../sessions/session-service";

export interface ConflictServiceDeps {
  db: Db;
  store: EventStore;
  inbox: InboxService;
  sessions: SessionService;
  /** Saves pasted images, so a recorded start refers to them instead of carrying the bytes. */
  artifacts: Pick<ArtifactService, "externalizeAttachments">;
  /** Tell the project's PM (a `conflict` notice). */
  onRecorded?: (record: ConflictRecord) => void;
}

/**
 * Persisted conflicts (§8.4): a start request that matched running work becomes an inbox
 * item of kind `conflict` plus its details, resolvable later with wait, skip, join or force.
 * Resolving retries the saved start (or the one the resolver sends instead) with the decision.
 */
export class ConflictService {
  constructor(private readonly deps: ConflictServiceDeps) {}

  /** Persist a conflict for `req`; returns the record (its id is the inbox item id). */
  record(req: StartSessionRequest, existing: WorkSummary[]): ConflictRecord {
    const purpose = derivePurpose(req.purpose, req.input?.text);
    const workKey = deriveWorkKey({
      workKey: req.workKey,
      issueNumber: req.issue?.number,
      purpose,
    });
    const now = new Date().toISOString();
    const id = `conflict:${randomUUID()}`;
    const { conflict: _drop, ...rest } = req;
    // Pasted images become artifacts first: the record goes into the event log, which is never
    // pruned (§6), so it keeps a reference rather than the image itself.
    const start = rest.input
      ? {
          ...rest,
          input: this.deps.artifacts.externalizeAttachments(rest.input, {
            sessionId: null,
            projectId: req.projectId,
          }),
        }
      : rest;
    const record: ConflictRecord = {
      id,
      projectId: req.projectId,
      request: { purpose, workKey, startedBy: req.startedBy },
      existing,
      start: JSON.parse(JSON.stringify(start)) as JsonValue,
      status: "open",
      resolution: null,
      outcome: null,
      createdAt: now,
      resolvedAt: null,
    };
    const first = existing[0];
    const item: InboxItem = {
      id,
      kind: "conflict",
      status: "open",
      priority: "normal",
      notify: "needs_you",
      title: `Already running: ${purpose}`,
      body: first
        ? `${first.workKey} (${first.status}) ${first.purpose}${first.progress ? ` · ${first.progress.text}` : ""}`
        : null,
      projectId: req.projectId,
      // The existing work is in the record; the item belongs to no session of its own.
      sessionId: null,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: req.issue ?? null,
      pr: null,
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
    this.deps.store.append([
      { type: "conflict.created", sessionId: null, payload: { conflict: record } },
      { type: "inbox.created", sessionId: null, payload: { item } },
    ]);
    this.deps.onRecorded?.(record);
    return record;
  }

  list(query: Partial<ListConflictsQuery> = {}): ConflictRecord[] {
    const status = query.status ?? "open";
    return this.deps.db
      .select()
      .from(conflicts)
      .where(query.projectId ? eq(conflicts.projectId, query.projectId) : undefined)
      .orderBy(desc(conflicts.createdAt))
      .limit(500)
      .all()
      .map((row) => this.withStatus(row.record))
      .filter((r) => r.status === status);
  }

  get(id: string): ConflictRecord {
    const row = this.deps.db.select().from(conflicts).where(eq(conflicts.id, id)).get();
    if (!row) throw notFound(`No conflict ${id}`, "conflict_not_found");
    return this.withStatus(row.record);
  }

  /**
   * Retry the start with the decision and close the inbox item. The saved request is retried
   * unless `request.start` replaces it (the New session draft as it is now). Only the decision
   * is kept on the item, never the replacement's input.
   */
  async resolve(id: string, request: ResolveConflictRequest): Promise<ResolveConflictResponse> {
    const record = this.get(id);
    if (record.status !== "open")
      throw conflictError("The conflict was already resolved", "resolved");
    const decision = ConflictDecision.parse(request);
    const replacement = request.start;
    if (replacement && replacement.projectId !== record.projectId) {
      throw badRequest("The new request is for another project", "project_mismatch");
    }
    const req = StartSessionRequest.parse({
      ...((replacement ?? record.start) as Record<string, unknown>),
      conflict: decision,
    });
    const result: StartSessionResponse = await this.deps.sessions.start(req);
    const item = this.deps.inbox.get(id);
    this.deps.inbox.close(item, decision.resolution === "skip" ? "dismissed" : "resolved", {
      decision: decision as unknown as JsonValue,
      outcome: result as unknown as JsonValue,
    });
    return { conflict: this.get(id), result };
  }

  /** Status, decision and outcome come from the inbox item. */
  private withStatus(record: ConflictRecord): ConflictRecord {
    let item: InboxItem | undefined;
    try {
      item = this.deps.inbox.get(record.id);
    } catch {
      item = undefined;
    }
    if (!item) return record;
    const resolution = item.resolution as { decision?: unknown; outcome?: unknown } | null;
    return ConflictRecord.parse({
      ...record,
      status: item.status,
      resolvedAt: item.resolvedAt,
      resolution: resolution?.decision ?? null,
      outcome: resolution?.outcome ?? null,
    });
  }
}
