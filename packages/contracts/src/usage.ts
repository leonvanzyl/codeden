import { z } from "zod";
import { GitHubPrRef, Id, ProviderId, Role, Timestamp } from "./common";

/**
 * Usage and cost reports (§12.6). The server keeps a ledger with one row per turn: the
 * turn's own token counts (never a running total) plus who and what the work was for.
 * Costs are labelled honestly: `reported` when the provider returned a USD figure,
 * `estimated` when CodeDen priced the tokens from its price table, `unpriced` when neither.
 */

/** Where a cost figure came from. */
export const CostSource = z.enum(["reported", "estimated", "unpriced"]);
export type CostSource = z.infer<typeof CostSource>;

/**
 * How a provider is paid for. `subscription` (a claude.ai or ChatGPT login) shows costs as
 * "API-equivalent": what the same work would cost on API credits, not a bill.
 */
export const BillingMode = z.enum(["api", "subscription", "unknown"]);
export type BillingMode = z.infer<typeof BillingMode>;

/** Who started the work a ledger row belongs to. `factory`: software- and dark-factory work. */
export const UsageSource = z.enum(["user", "orchestrator", "pm", "automation", "factory"]);
export type UsageSource = z.infer<typeof UsageSource>;

/** Token counts in the four billed categories, plus reasoning (a subset of output). */
export const TokenCounts = z.object({
  /** Uncached input tokens (excludes cache reads and writes). */
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  /** Reasoning/thinking tokens where reported; already counted in `outputTokens`. */
  reasoningTokens: z.int().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCounts>;

/** One turn's usage as stored in the ledger. */
export const UsageEntry = z.object({
  ...TokenCounts.shape,
  sessionId: Id,
  turnId: Id,
  projectId: Id.nullable(),
  provider: ProviderId,
  model: z.string(),
  role: Role,
  source: UsageSource,
  automationId: Id.nullable(),
  /** USD the provider reported for this turn, when it reports one. */
  reportedCostUsd: z.number().nonnegative().nullable(),
  /** The figure used in reports (reported, else estimated from the price table). */
  costUsd: z.number().nonnegative(),
  costSource: CostSource,
  /** When the turn first reported usage. */
  ts: Timestamp,
});
export type UsageEntry = z.infer<typeof UsageEntry>;

/** Price of a model in USD per million tokens. */
export const ModelPrice = z.object({
  provider: ProviderId,
  /** Model id or alias; matched exactly, then as a prefix (`claude-sonnet-4-5` matches dated ids). */
  model: z.string().min(1),
  label: z.string().optional(),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
  /** Date the list price was checked (YYYY-MM-DD). */
  asOf: z.iso.date(),
  /** Where the price came from. */
  sourceUrl: z.url().optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** A spend alert: daily or monthly, for everything or one project. */
export const UsageBudget = z.object({
  id: Id,
  projectId: Id.nullable(),
  period: z.enum(["daily", "monthly"]),
  limitUsd: z.number().positive(),
  /** Warn once spend reaches this share of the limit (and again when it is exceeded). */
  warnAtPercent: z.int().min(1).max(100).default(80),
  enabled: z.boolean().default(true),
});
export type UsageBudget = z.infer<typeof UsageBudget>;
export type UsageBudgetInit = z.input<typeof UsageBudget>;

/** User-editable usage settings (`usage-settings.json` in the data directory). */
export const UsageSettings = z.object({
  /** Price overrides and additions; they win over the bundled table for the same model. */
  prices: z.array(ModelPrice).default([]),
  budgets: z.array(UsageBudget).default([]),
  /** Raise an inbox item when a rate-limit window reaches this percentage. */
  rateLimitWarnPercent: z.int().min(1).max(100).default(85),
  /** IANA timezone that days and months are counted in; the machine's when null. */
  timezone: z.string().nullable().default(null),
});
export type UsageSettings = z.infer<typeof UsageSettings>;
export type UsageSettingsInit = z.input<typeof UsageSettings>;

/** `GET /api/usage/settings` and `PUT /api/usage/settings`. */
export const UsageSettingsResponse = z.object({
  settings: UsageSettings,
  /** The bundled list prices (read-only; override them in `settings.prices`). */
  bundledPrices: z.array(ModelPrice),
});
export type UsageSettingsResponse = z.infer<typeof UsageSettingsResponse>;

/** Range and filters for report queries. Dates are inclusive local days (YYYY-MM-DD). */
export const UsageQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  projectId: Id.optional(),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  role: Role.optional(),
  source: UsageSource.optional(),
});
export type UsageQuery = z.infer<typeof UsageQuery>;

/** Totals over a set of ledger rows. */
export const UsageTotals = z.object({
  ...TokenCounts.shape,
  costUsd: z.number().nonnegative(),
  /** Part of `costUsd` that is estimated rather than reported. */
  estimatedCostUsd: z.number().nonnegative(),
  /** Turns whose model has no price and no reported cost. */
  unpricedTurns: z.int().nonnegative(),
  turns: z.int().nonnegative(),
  sessions: z.int().nonnegative(),
  /** Cache reads / (cache reads + cache writes + uncached input); null with no input. */
  cacheHitRate: z.number().min(0).max(1).nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** Dimensions reports break down by. */
export const UsageDimension = z.enum(["provider", "model", "project", "role", "source"]);
export type UsageDimension = z.infer<typeof UsageDimension>;

/** One value of a dimension with its daily cost and tokens (aligned with `UsageReport.days`). */
export const UsageSeries = z.object({
  key: z.string(),
  label: z.string(),
  costUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  tokens: z.int().nonnegative(),
  turns: z.int().nonnegative(),
  sessions: z.int().nonnegative(),
  dailyCostUsd: z.array(z.number().nonnegative()),
  dailyTokens: z.array(z.int().nonnegative()),
});
export type UsageSeries = z.infer<typeof UsageSeries>;

/** A session ranked by cost. */
export const UsageSessionRow = z.object({
  sessionId: Id,
  title: z.string(),
  projectId: Id.nullable(),
  projectName: z.string().nullable(),
  provider: ProviderId,
  model: z.string(),
  role: Role,
  source: UsageSource,
  costUsd: z.number().nonnegative(),
  estimated: z.boolean(),
  tokens: z.int().nonnegative(),
  turns: z.int().nonnegative(),
  lastAt: Timestamp,
  pr: GitHubPrRef.nullable(),
});
export type UsageSessionRow = z.infer<typeof UsageSessionRow>;

/** Spend of one automation. */
export const AutomationSpend = z.object({
  automationId: Id,
  name: z.string(),
  costUsd: z.number().nonnegative(),
  sessions: z.int().nonnegative(),
});
export type AutomationSpend = z.infer<typeof AutomationSpend>;

/** `GET /api/usage/report`. */
export const UsageReport = z.object({
  query: UsageQuery,
  timezone: z.string(),
  /** Local days in the range, oldest first. */
  days: z.array(z.iso.date()),
  totals: UsageTotals,
  /** The same totals for the equally long range just before (for trend arrows). */
  previousTotals: UsageTotals,
  series: z.record(UsageDimension, z.array(UsageSeries)),
  topSessions: z.array(UsageSessionRow),
  automations: z.object({
    manualCostUsd: z.number().nonnegative(),
    automationCostUsd: z.number().nonnegative(),
    factoryCostUsd: z.number().nonnegative(),
    byAutomation: z.array(AutomationSpend),
  }),
  averages: z.object({
    perSessionUsd: z.number().nonnegative().nullable(),
    /** Spend of sessions whose PR merged, divided by the merged PRs (null with none). */
    perMergedPrUsd: z.number().nonnegative().nullable(),
    mergedPrs: z.int().nonnegative(),
  }),
  /** How each provider in the range is billed, for the "API-equivalent" label. */
  billing: z.record(ProviderId, BillingMode),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** One turn's usage for the turn footer. */
export const TurnUsage = z.object({
  ...TokenCounts.shape,
  turnId: Id,
  costUsd: z.number().nonnegative(),
  costSource: CostSource,
});
export type TurnUsage = z.infer<typeof TurnUsage>;

/** One model's share of a subagent run's cost. */
export const SubagentModelCost = z.object({
  ...TokenCounts.shape,
  /** The model the tokens were priced as (the session's model when the provider named none). */
  model: z.string(),
  /** The price table's name for the model, when it has one. */
  label: z.string().optional(),
  costUsd: z.number().nonnegative(),
  costSource: CostSource,
});
export type SubagentModelCost = z.infer<typeof SubagentModelCost>;

/**
 * What a finished subagent run cost, priced from `SubagentStats.usage` when read (§7.3). Display
 * only: the run's tokens are already in its session's turns, so this is never added to totals.
 * `reported` when every model's cost came from the provider, `unpriced` when no model could be
 * priced, else `estimated`.
 */
export const SubagentCost = z.object({
  /** The `subagent` item. */
  itemId: Id,
  costUsd: z.number().nonnegative(),
  costSource: CostSource,
  models: z.array(SubagentModelCost),
});
export type SubagentCost = z.infer<typeof SubagentCost>;

/** `GET /api/usage/sessions/:id`: totals for the session header plus per-turn rows. */
export const SessionUsage = z.object({
  sessionId: Id,
  totals: UsageTotals,
  billing: BillingMode,
  turns: z.array(TurnUsage),
  /** The cost of each finished subagent that reported tokens per model, for its card. */
  subagents: z.array(SubagentCost).default([]),
});
export type SessionUsage = z.infer<typeof SessionUsage>;

/** A provider rate-limit window as last reported. */
export const RateLimitWindow = z.object({
  provider: ProviderId,
  /** Window id from the provider: `5h`, `weekly`, `weekly-opus`, ... */
  windowId: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warning", "limited"]),
  /**
   * The share used, from the latest reading that had one; null when none has been read in the
   * current window. Claude often reports only the status, so this can be older than the status.
   */
  usedPercent: z.number().min(0).max(100).nullable(),
  /** When `usedPercent` was read (null without one); can be earlier than `observedAt`. */
  usedPercentAt: Timestamp.nullable(),
  resetsAt: Timestamp.nullable(),
  /** When the latest reading (status, reset time) arrived. */
  observedAt: Timestamp,
  /** The window has reset since this reading, so the percentage is out of date. */
  stale: z.boolean(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindow>;

/** `GET /api/usage/limits`. */
export const RateLimitsResponse = z.object({
  windows: z.array(RateLimitWindow),
  warnPercent: z.int(),
  billing: z.record(ProviderId, BillingMode),
});
export type RateLimitsResponse = z.infer<typeof RateLimitsResponse>;

/** Where a budget stands in its current period. */
export const BudgetStatus = z.object({
  budget: UsageBudget,
  periodStart: z.iso.date(),
  spentUsd: z.number().nonnegative(),
  percent: z.number().nonnegative(),
  state: z.enum(["ok", "warning", "exceeded"]),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/** `GET /api/usage/budgets`. */
export const BudgetsResponse = z.object({ budgets: z.array(BudgetStatus) });
export type BudgetsResponse = z.infer<typeof BudgetsResponse>;

/** `GET /api/usage/projects/:id`: the project home spend card. */
export const ProjectSpend = z.object({
  projectId: Id,
  todayUsd: z.number().nonnegative(),
  last7Usd: z.number().nonnegative(),
  monthUsd: z.number().nonnegative(),
  estimated: z.boolean(),
  /** Last 14 local days, oldest first. */
  dailyUsd: z.array(z.number().nonnegative()),
  topModel: z.string().nullable(),
  budgets: z.array(BudgetStatus),
  billing: z.record(ProviderId, BillingMode),
});
export type ProjectSpend = z.infer<typeof ProjectSpend>;
