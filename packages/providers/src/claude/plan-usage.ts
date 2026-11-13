import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Usage } from "@codeden/contracts";
import { usageFromPlanUsage, usageFromRateLimit } from "./usage";

/**
 * The SDK method behind Claude Code's `/usage`: plan rate-limit utilization per window. The SDK
 * marks it experimental (its name will change once it is stable), so it is called only when the
 * installed SDK has it, and any failure just means no reading. `satisfies` makes a rename in an
 * SDK upgrade fail `pnpm typecheck` instead of silently stopping the readings.
 */
const PLAN_USAGE_METHOD =
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" satisfies keyof Query;

type RateLimit = NonNullable<Usage["rateLimits"]>[number];

/** Reset times this close belong to the same window (both sources round to the minute). */
const SAME_RESET_MS = 2 * 60_000;

/**
 * Read the subscription's usage windows (5-hour, weekly, weekly per model) from a running
 * query. Undefined for API keys and cloud providers, SDKs without the method, or on failure.
 * `skipBehaviors` skips the SDK's scan of local transcripts, which only the `/usage` dialog
 * needs.
 */
export async function readPlanUsage(q: Query): Promise<Usage | undefined> {
  const read = (q as Partial<Query>)[PLAN_USAGE_METHOD];
  if (typeof read !== "function") return undefined;
  try {
    return usageFromPlanUsage(await read.call(q, { skipBehaviors: true }));
  } catch {
    return undefined;
  }
}

/**
 * Plan usage readings for one session. Plan usage carries figures but no status of its own, so a
 * window under 100% keeps the warning or limit Claude last reported for that same window (a
 * `rate_limit_event`) instead of reading "ok" after every turn.
 */
export class PlanUsageReader {
  private readonly said = new Map<string, Pick<RateLimit, "status" | "resetsAt">>();

  /** Remember the status a `rate_limit_event` reported for its window. */
  noteEvent(message: unknown): void {
    for (const w of usageFromRateLimit(message)?.rateLimits ?? []) {
      this.said.set(w.id, { status: w.status, resetsAt: w.resetsAt });
    }
  }

  async read(q: Query): Promise<Usage | undefined> {
    const usage = await readPlanUsage(q);
    if (!usage?.rateLimits) return usage;
    return { rateLimits: usage.rateLimits.map((w) => this.withStatus(w)) };
  }

  private withStatus(w: RateLimit): RateLimit {
    const said = this.said.get(w.id);
    if (w.status !== "ok" || !said || said.status === "ok") return w;
    if (!said.resetsAt || !w.resetsAt) return w;
    const sameWindow =
      Math.abs(Date.parse(said.resetsAt) - Date.parse(w.resetsAt)) <= SAME_RESET_MS;
    return sameWindow ? { ...w, status: said.status } : w;
  }
}
