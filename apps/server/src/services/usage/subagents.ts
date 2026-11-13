import type {
  CostSource,
  Item,
  ModelPrice,
  SubagentCost,
  SubagentModelCost,
  SubagentModelUsage,
} from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items } from "../../db/schema";
import { costOf, findPrice } from "./prices";

/** The session a subagent ran in: its provider, and the model its runs use unless they say. */
export interface SubagentSession {
  provider: string;
  model: string | null;
}

/** The provider's USD figure for some calls, read like a ledger row's (`reportedCost`). */
function reportedCost(u: SubagentModelUsage): number | null {
  if (u.costUsd === undefined) return null;
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  // Providers that don't price report 0, so a zero with tokens is not a figure.
  return u.costUsd === 0 && tokens > 0 ? null : u.costUsd;
}

/**
 * What a subagent run cost (§7.3), from its tokens per model: each model is priced like a turn
 * (§12.6), the provider's figure when it gave one, else the price table (overrides first), and
 * a model the run didn't name is the session's. `reported` when every model's cost was
 * reported, `unpriced` when none could be priced, else `estimated`. Pure.
 */
export function priceSubagent(
  itemId: string,
  usage: readonly SubagentModelUsage[],
  session: SubagentSession,
  overrides: ModelPrice[] = [],
): SubagentCost {
  const models: SubagentModelCost[] = usage.map((u) => {
    const model = u.model ?? session.model ?? "default";
    const tokens = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      reasoningTokens: u.reasoningTokens ?? 0,
    };
    const cost = costOf(
      { ...tokens, provider: session.provider, model, reportedCostUsd: reportedCost(u) },
      overrides,
    );
    const label = findPrice(session.provider, model, overrides)?.label;
    return { model, ...(label ? { label } : {}), ...tokens, ...cost };
  });
  const costUsd = models.reduce((sum, m) => sum + m.costUsd, 0);
  return {
    itemId,
    costUsd: Math.round(costUsd * 1e9) / 1e9,
    costSource: overallSource(models.map((m) => m.costSource)),
    models,
  };
}

function overallSource(sources: CostSource[]): CostSource {
  if (sources.length > 0 && sources.every((s) => s === "reported")) return "reported";
  if (sources.every((s) => s === "unpriced")) return "unpriced";
  return "estimated";
}

/**
 * The cost of each finished subagent of a session that reported tokens per model, priced now
 * (so price-table edits apply). Display only: nothing here reaches the ledger or its totals.
 */
export function subagentCosts(
  db: Db,
  sessionId: string,
  session: SubagentSession,
  overrides: ModelPrice[],
): SubagentCost[] {
  const rows = db
    .select({ data: items.data })
    .from(items)
    .where(and(eq(items.sessionId, sessionId), eq(items.kind, "subagent")))
    .all();
  const out: SubagentCost[] = [];
  for (const { data } of rows) {
    const usage = finishedUsage(data);
    if (usage) out.push(priceSubagent(data.id, usage, session, overrides));
  }
  return out;
}

function finishedUsage(item: Item): SubagentModelUsage[] | undefined {
  if (item.kind !== "subagent" || item.status === "in_progress") return undefined;
  const usage = item.stats?.usage;
  return usage?.length ? usage : undefined;
}
