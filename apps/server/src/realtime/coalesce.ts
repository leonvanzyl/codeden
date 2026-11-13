import { type AgentEventOf, mergeItemDeltas, type RawEventEnvelope } from "@codeden/contracts";

type DeltaPayload = AgentEventOf<"item.delta">;

function asDelta(e: RawEventEnvelope): DeltaPayload | undefined {
  return e.type === "agent.item.delta" ? (e.payload as DeltaPayload) : undefined;
}

/**
 * Merge runs of consecutive text deltas for the same item into one event carrying the last
 * seq and timestamp, so a burst of streamed tokens reaches the UI as one update. Order is
 * preserved and every other event passes through untouched. Pure.
 */
export function coalesceEvents(events: RawEventEnvelope[]): RawEventEnvelope[] {
  const out: RawEventEnvelope[] = [];
  for (const event of events) {
    const prev = out.at(-1);
    const a = prev ? asDelta(prev) : undefined;
    const b = asDelta(event);
    const merged =
      prev && a && b && prev.sessionId === event.sessionId ? mergeItemDeltas(a, b) : undefined;
    if (merged) {
      out[out.length - 1] = { ...event, payload: merged };
      continue;
    }
    out.push(event);
  }
  return out;
}
