import type { Role, UsageSource } from "@codeden/contracts";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Usage ledger (§12.6): one row per turn holding that turn's own usage (never a running
 * total), written in the same transaction as the `usage.updated` event that reports it.
 * Who and what the work was for is copied from the session at write time, so reports never
 * depend on later changes to the session or project. Costs are not stored except where the
 * provider reported one: estimates are priced at query time from the current price table.
 */
export const usageLedger = sqliteTable(
  "usage_ledger",
  {
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    threadId: text("thread_id").notNull(),
    projectId: text("project_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    role: text("role").$type<Role>().notNull(),
    source: text("source").$type<UsageSource>().notNull(),
    automationId: text("automation_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    /** USD the provider reported for this turn; null when it reports none. */
    reportedCostUsd: real("reported_cost_usd"),
    /** When the turn first reported usage (the day it is counted on). */
    ts: text("ts").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.turnId] }),
    index("usage_ledger_ts").on(t.ts),
    index("usage_ledger_project_ts").on(t.projectId, t.ts),
  ],
);

/** Latest reading of each provider rate-limit window (Claude 5-hour/weekly, Codex snapshots). */
export const rateLimitWindows = sqliteTable(
  "rate_limit_windows",
  {
    provider: text("provider").notNull(),
    windowId: text("window_id").notNull(),
    status: text("status").$type<"ok" | "warning" | "limited">().notNull(),
    /** Latest percentage read in the current window (a later status-only reading keeps it). */
    usedPercent: real("used_percent"),
    /** When `usedPercent` was read. */
    usedPercentAt: text("used_percent_at"),
    resetsAt: text("resets_at"),
    observedAt: text("observed_at").notNull(),
    /** Session whose provider reported it. */
    sessionId: text("session_id"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.windowId] })],
);
