import type { AutonomyMode, Session, Usage, UsageSource } from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import { automationRuns, projects, sessions } from "../../db/schema";
import { rateLimitWindows, usageLedger } from "../../db/schema-usage";
import type { Tx } from "../../events/projection-db";

/** Who started a session, in report terms. Software- and dark-factory work is `factory`. */
export function sourceOf(
  startedBy: Session["startedBy"]["kind"],
  autonomyMode: AutonomyMode | null,
): UsageSource {
  const factory = autonomyMode === "software_factory" || autonomyMode === "dark_factory";
  if (startedBy === "user") return "user";
  if (factory) return "factory";
  return startedBy;
}

/** The ledger's token columns from a turn's usage report. */
export function ledgerTokens(usage: Usage) {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cachedInputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

/**
 * The provider's USD figure, or null when it has none. A zero cost with tokens is treated as
 * "not reported" (providers that do not price report 0), so the tokens get estimated.
 */
export function reportedCost(usage: Usage): number | null {
  const tokens = Object.values(ledgerTokens(usage)).reduce((a, b) => a + b, 0);
  if (usage.costUsd === undefined) return tokens === 0 ? 0 : null;
  if (usage.costUsd === 0 && tokens > 0) return null;
  return usage.costUsd;
}

/** True when a report carries token counts or cost. */
function hasTokens(usage: Usage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.costUsd !== undefined
  );
}

interface UsageReport {
  sessionId: string;
  threadId: string;
  turnId: string | undefined;
  usage: Usage;
  ts: string;
}

/** Session attribution copied onto ledger rows: project, role, source, automation. */
export function attribution(tx: Tx, sessionId: string) {
  const s = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!s) return undefined;
  const project = s.projectId
    ? tx
        .select({ mode: projects.autonomyMode })
        .from(projects)
        .where(eq(projects.id, s.projectId))
        .get()
    : undefined;
  const run = s.automationRunId
    ? tx
        .select({ automationId: automationRuns.automationId })
        .from(automationRuns)
        .where(eq(automationRuns.id, s.automationRunId))
        .get()
    : undefined;
  const automationId = run?.automationId ?? null;
  const startedBy = automationId ? "automation" : s.startedBy.kind;
  return {
    projectId: s.projectId,
    provider: s.provider,
    model: s.model ?? "default",
    role: s.role as Session["role"],
    source: sourceOf(startedBy, (project?.mode as AutonomyMode | undefined) ?? null),
    automationId,
  };
}

/**
 * Ledger projection for one `usage.updated` (§12.6), run inside the append transaction. A
 * report with a turn id upserts that turn's row with the turn's usage so far (providers
 * report per-turn figures); rate-limit windows are kept per window id as their latest reading,
 * with the last known percentage when the latest reading has none.
 */
export function applyUsageReport(tx: Tx, report: UsageReport): void {
  const { usage } = report;
  if (report.turnId && hasTokens(usage)) {
    const who = attribution(tx, report.sessionId);
    if (who) {
      const values = {
        sessionId: report.sessionId,
        turnId: report.turnId,
        threadId: report.threadId,
        ...who,
        ...ledgerTokens(usage),
        reportedCostUsd: reportedCost(usage),
        ts: report.ts,
        updatedAt: report.ts,
      };
      const { ts: _first, sessionId: _s, turnId: _t, ...update } = values;
      tx.insert(usageLedger)
        .values(values)
        .onConflictDoUpdate({ target: [usageLedger.sessionId, usageLedger.turnId], set: update })
        .run();
    }
  }
  if (usage.rateLimits?.length) {
    const provider = tx
      .select({ provider: sessions.provider })
      .from(sessions)
      .where(eq(sessions.id, report.sessionId))
      .get()?.provider;
    if (!provider) return;
    for (const w of usage.rateLimits) {
      const prev = storedWindow(tx, provider, w.id);
      const row = {
        provider,
        windowId: w.id,
        status: w.status,
        ...percentOf(w.usedPercent, prev, report.ts),
        resetsAt:
          prev?.resetsAt && sameReset(prev.resetsAt, w.resetsAt)
            ? prev.resetsAt
            : (w.resetsAt ?? null),
        observedAt: report.ts,
        sessionId: report.sessionId,
      };
      tx.insert(rateLimitWindows)
        .values(row)
        .onConflictDoUpdate({
          target: [rateLimitWindows.provider, rateLimitWindows.windowId],
          set: row,
        })
        .run();
    }
  }
}

/** The stored reading of a window, if any. */
function storedWindow(tx: Tx, provider: string, windowId: string) {
  return tx
    .select({
      usedPercent: rateLimitWindows.usedPercent,
      usedPercentAt: rateLimitWindows.usedPercentAt,
      observedAt: rateLimitWindows.observedAt,
      resetsAt: rateLimitWindows.resetsAt,
    })
    .from(rateLimitWindows)
    .where(and(eq(rateLimitWindows.provider, provider), eq(rateLimitWindows.windowId, windowId)))
    .get();
}

/**
 * A window's percentage and when it was read. A reading without one (Claude often reports only
 * the status) keeps the stored figure while that window has not reset: its reset time is known
 * and still after `at`, so the figure still describes the current window.
 */
function percentOf(
  next: number | undefined,
  prev: ReturnType<typeof storedWindow>,
  at: string,
): { usedPercent: number | null; usedPercentAt: string | null } {
  if (next !== undefined) return { usedPercent: next, usedPercentAt: at };
  const current = !!prev?.resetsAt && Date.parse(prev.resetsAt) > Date.parse(at);
  if (!current || prev?.usedPercent == null) return { usedPercent: null, usedPercentAt: null };
  return { usedPercent: prev.usedPercent, usedPercentAt: prev.usedPercentAt ?? prev.observedAt };
}

/** Two reset times this close describe the same window; a new window resets hours later. */
const SAME_RESET_MS = 2 * 60_000;

/**
 * True when a new reset time is the stored one, give or take the sources' rounding (Claude's
 * events report whole seconds, its plan usage fractions of one). The stored string is then
 * kept, so one window keeps one reset time, and with it one alert id.
 */
function sameReset(stored: string, next: string | undefined): boolean {
  if (!next) return false;
  return Math.abs(Date.parse(stored) - Date.parse(next)) <= SAME_RESET_MS;
}
