import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Usage } from "@codeden/contracts";
import { usageFromPlanUsage } from "./usage";

/**
 * The SDK method behind Claude Code's `/usage`: plan rate-limit utilization per window. The SDK
 * marks it experimental (its name will change once it is stable), so it is called only when the
 * installed SDK has it, and any failure just means no reading.
 */
const PLAN_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/**
 * Read the subscription's usage windows (5-hour, weekly, weekly per model) from a running
 * query. Undefined for API keys and cloud providers, SDKs without the method, or on failure.
 * `skipBehaviors` skips the SDK's scan of local transcripts, which only the `/usage` dialog
 * needs.
 */
export async function readPlanUsage(q: Query): Promise<Usage | undefined> {
  const read = (q as unknown as Record<string, unknown>)[PLAN_USAGE_METHOD];
  if (typeof read !== "function") return undefined;
  try {
    return usageFromPlanUsage(await read.call(q, { skipBehaviors: true }));
  } catch {
    return undefined;
  }
}
