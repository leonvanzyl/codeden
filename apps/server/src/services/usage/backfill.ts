import type { Usage } from "@codeden/contracts";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { turns } from "../../db/schema";
import { usageLedger } from "../../db/schema-usage";
import { attribution, ledgerTokens, reportedCost } from "./ledger";

const ADDITIVE = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "costUsd",
] as const;

/**
 * Providers whose turn usage was stored as running totals before the ledger existed (the
 * Claude query total and the Codex thread total). Codex also counted cached input inside
 * `inputTokens` then.
 */
const RUNNING_TOTALS: Record<string, { cachedInInput: boolean }> = {
  claude: { cachedInInput: false },
  codex: { cachedInInput: true },
};

/**
 * Turn usage from two consecutive stored running totals. A total smaller than the previous one
 * in any field means the provider process restarted, so the report is the turn's own. Pure.
 */
export function deltaFromTotals(current: Usage, previous: Usage | undefined): Usage {
  if (!previous) return current;
  const reset = ADDITIVE.some((f) => (current[f] ?? 0) < (previous[f] ?? 0));
  if (reset) return current;
  const out: Usage = { ...current };
  for (const f of ADDITIVE) {
    if (current[f] === undefined) continue;
    const diff = (current[f] ?? 0) - (previous[f] ?? 0);
    out[f] = f === "costUsd" ? Math.round(diff * 1e9) / 1e9 : Math.round(diff);
  }
  return out;
}

function hasTokens(u: Usage | null): u is Usage {
  return Boolean(u && ADDITIVE.some((f) => u[f] !== undefined));
}

/**
 * One-time backfill (§12.6): turns that reported usage before the ledger existed get a ledger
 * row. Turns written since always have one (the projection runs in the event's transaction),
 * so this is a no-op after the first start. Returns the number of rows added.
 */
export function backfillUsageLedger(db: Db): number {
  const rows = db
    .select({ turn: turns })
    .from(turns)
    .leftJoin(
      usageLedger,
      and(eq(usageLedger.sessionId, turns.sessionId), eq(usageLedger.turnId, turns.id)),
    )
    .where(and(isNotNull(turns.usage), isNull(usageLedger.turnId)))
    .orderBy(asc(turns.sessionId), asc(turns.startedAt))
    .all();
  if (rows.length === 0) return 0;
  let added = 0;
  db.transaction((tx) => {
    let previous: { sessionId: string; usage: Usage } | undefined;
    for (const { turn } of rows) {
      if (!hasTokens(turn.usage)) continue;
      const who = attribution(tx, turn.sessionId);
      if (!who) continue;
      const mode = RUNNING_TOTALS[who.provider];
      let usage = turn.usage;
      if (mode) {
        const prev = previous?.sessionId === turn.sessionId ? previous.usage : undefined;
        usage = deltaFromTotals(turn.usage, prev);
        previous = { sessionId: turn.sessionId, usage: turn.usage };
        if (mode.cachedInInput && usage.inputTokens !== undefined) {
          usage = {
            ...usage,
            inputTokens: Math.max(
              0,
              usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
            ),
          };
        }
      }
      tx.insert(usageLedger)
        .values({
          sessionId: turn.sessionId,
          turnId: turn.id,
          threadId: turn.threadId,
          ...who,
          ...ledgerTokens(usage),
          reportedCostUsd: reportedCost(usage),
          ts: turn.startedAt,
          updatedAt: turn.completedAt ?? turn.startedAt,
        })
        .onConflictDoNothing()
        .run();
      added++;
    }
  });
  return added;
}
