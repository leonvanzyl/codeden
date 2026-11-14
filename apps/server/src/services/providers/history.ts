import {
  HideProviderHistoryRequest,
  type HideProviderHistoryResponse,
  PROVIDER_HISTORY_MAX,
  type ProviderHistoryEntry,
  type ProviderHistoryResponse,
  type SessionStatus,
} from "@codeden/contracts";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema";
import { badRequest, ServiceError } from "../errors";
import { type RunnerDeps, type RunnerPort, toServiceError } from "../runner-port";

/** Starting a short-lived provider process and reading its history takes a few seconds. */
const LIST_TIMEOUT_MS = 60_000;
const HIDE_TIMEOUT_MS = 120_000;

/**
 * Sessions that may have a turn running: their conversation is left alone (the provider hides it
 * itself once the turn ends).
 */
const BUSY: ReadonlySet<SessionStatus> = new Set(["starting", "running", "waiting"]);

export interface ProviderHistoryDeps extends RunnerDeps {
  db: Db;
}

/** A recorded conversation: a session's resume token. */
interface Recorded {
  sessionId: string;
  title: string | null;
  resumeToken: string;
}

/** Recorded conversations of one runner (each runner has its own provider homes). */
interface RunnerGroup {
  runner: RunnerPort;
  byToken: Map<string, Recorded>;
}

/**
 * "Hide CodeDen's sessions from <provider>'s app" (Settings → Providers). Some vendors' apps
 * list every conversation in the user's home as the user's own history (`vendorHistory`). This
 * finds the ones CodeDen started, from its own record (its sessions' resume tokens, never a guess
 * from titles), and hides them on request. Only recorded conversations are ever sent to a
 * runner, so the user's own conversations are never looked at or touched.
 */
export class ProviderHistoryService {
  constructor(private readonly deps: ProviderHistoryDeps) {}

  /** What hiding would do: the recorded conversations the vendor's apps list now. */
  async preview(providerId: string): Promise<ProviderHistoryResponse> {
    const { recorded, groups } = this.recorded(providerId);
    const entries: ProviderHistoryResponse["entries"] = [];
    for (const group of groups) {
      for (const entry of await this.list(group, providerId)) {
        const session = group.byToken.get(entry.resumeToken);
        if (!session) continue;
        entries.push({ ...entry, sessionId: session.sessionId, sessionTitle: session.title });
      }
    }
    entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { providerId, recorded, entries };
  }

  /**
   * Hide what `preview` lists, once the user confirmed it (`confirm: true`; anything else is
   * refused before a runner is asked anything). Hidden, not deleted: CodeDen can still resume.
   */
  async hide(providerId: string, request: unknown): Promise<HideProviderHistoryResponse> {
    if (!HideProviderHistoryRequest.safeParse(request).success) {
      throw badRequest("Confirm the list before hiding it", "confirmation_required");
    }
    const result: HideProviderHistoryResponse = { providerId, hidden: [], missing: [], failed: [] };
    for (const group of this.recorded(providerId).groups) {
      // Only the recorded conversations the vendor's apps still list.
      const listed = (await this.list(group, providerId)).filter((e) =>
        group.byToken.has(e.resumeToken),
      );
      if (listed.length === 0) continue;
      const done = await group.runner
        .request(
          {
            name: "provider.history.hide",
            providerId,
            resumeTokens: listed.map((e) => e.resumeToken),
          },
          HIDE_TIMEOUT_MS,
        )
        .catch((error: unknown) => {
          throw toServiceError(error);
        });
      result.hidden.push(...done.hidden);
      result.missing.push(...done.missing);
      result.failed.push(...done.failed);
    }
    return result;
  }

  /**
   * CodeDen's recorded conversations on `providerId`, by the runner that holds them, newest
   * first. Sessions that may be running a turn, and runners that are away or can't hide, are
   * left out. Throws when no runner can.
   */
  private recorded(providerId: string): { recorded: number; groups: RunnerGroup[] } {
    const rows = this.deps.db
      .select({
        id: sessions.id,
        title: sessions.title,
        status: sessions.status,
        resumeToken: sessions.resumeToken,
        runnerId: sessions.runnerId,
      })
      .from(sessions)
      .where(and(eq(sessions.provider, providerId), isNotNull(sessions.resumeToken)))
      .orderBy(desc(sessions.createdAt))
      .limit(PROVIDER_HISTORY_MAX)
      .all();
    const byRunner = new Map<string, RunnerGroup>();
    for (const row of rows) {
      if (!row.resumeToken || BUSY.has(row.status as SessionStatus)) continue;
      const key = row.runnerId ?? "";
      let group = byRunner.get(key);
      if (!group) {
        const runner =
          row.runnerId && this.deps.runners
            ? this.deps.runners.forRunnerId(row.runnerId)
            : this.deps.runner;
        group = { runner, byToken: new Map() };
        byRunner.set(key, group);
      }
      if (!group.byToken.has(row.resumeToken)) {
        group.byToken.set(row.resumeToken, {
          sessionId: row.id,
          title: row.title,
          resumeToken: row.resumeToken,
        });
      }
    }
    const canHide = (runner: RunnerPort) =>
      runner.isConnected() &&
      runner.providers().some((p) => p.id === providerId && p.capabilities.vendorHistory);
    if (!canHide(this.deps.runner) && ![...byRunner.values()].some((g) => canHide(g.runner))) {
      throw new ServiceError(
        409,
        "unsupported",
        `${providerId} has no history of its own that CodeDen can hide`,
      );
    }
    return {
      recorded: rows.filter((r) => r.resumeToken).length,
      groups: [...byRunner.values()].filter((g) => canHide(g.runner)),
    };
  }

  private async list(group: RunnerGroup, providerId: string): Promise<ProviderHistoryEntry[]> {
    if (group.byToken.size === 0) return [];
    try {
      const { entries } = await group.runner.request(
        { name: "provider.history.list", providerId, resumeTokens: [...group.byToken.keys()] },
        LIST_TIMEOUT_MS,
      );
      return entries;
    } catch (error) {
      throw toServiceError(error);
    }
  }
}
