import { describe, expect, it } from "vitest";
import {
  FACTORY_FAILED_SHOWN_MS,
  FactoryDismissRequest,
  type FactoryNeedItem,
  factoryNeed,
  factoryNeedLabel,
} from "../src";

/** Issue #265: one definition of the factory work that waits on a person, and what it needs. */

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const item = (patch: Partial<FactoryNeedItem>): FactoryNeedItem => ({
  stage: "failed",
  failureKind: "checks",
  finishedAt: ago(60_000),
  updatedAt: ago(60_000),
  attempts: 0,
  ...patch,
});

describe("what factory work needs from a person (#265)", () => {
  it("names the action for each kind of work that waits on you", () => {
    const at = { now: NOW, ownsOpenPr: false };
    expect(factoryNeed(item({ stage: "escalated", failureKind: "stuck" }), at)).toBe("merge");
    expect(factoryNeed(item({ attempts: 3 }), { ...at, ownsOpenPr: true })).toBe("retry");
    expect(factoryNeed(item({}), at)).toBe("retry_or_dismiss");
    expect(factoryNeed(item({ stage: "building" }), { ...at, agentWaiting: true })).toBe("answer");
    expect(factoryNeed(item({ stage: "verifying" }), { ...at, prWaitsForYou: true })).toBe("merge");
  });

  it("leaves out what the factory finishes or recovers by itself", () => {
    const at = { now: NOW, ownsOpenPr: false };
    // An infrastructure failure the loop still puts back.
    expect(factoryNeed(item({ failureKind: "infrastructure" }), { ...at, recovering: true })).toBe(
      null,
    );
    // A failure without a PR from before the last day.
    expect(factoryNeed(item({ finishedAt: ago(FACTORY_FAILED_SHOWN_MS + 1) }), at)).toBeNull();
    for (const stage of ["merged", "rejected", "reverted", "ignored", "building"] as const)
      expect(factoryNeed(item({ stage }), at)).toBeNull();
  });

  it("says what is needed in a few words", () => {
    expect(factoryNeedLabel("merge", { attempts: 0, prNumber: 12 })).toBe(
      "Review and merge PR #12",
    );
    expect(factoryNeedLabel("retry", { attempts: 3, prNumber: 12 })).toBe(
      "Retry: stopped after 3 review rounds",
    );
    expect(factoryNeedLabel("retry", { attempts: 0, prNumber: 12 })).toBe(
      "Retry: stopped with PR #12 open",
    );
    expect(factoryNeedLabel("retry_or_dismiss", { attempts: 0, prNumber: null })).toBe(
      "Retry or dismiss: stopped without a pull request",
    );
    expect(factoryNeedLabel("answer", { attempts: 0, prNumber: null })).toBe(
      "Answer the agent's question",
    );
  });

  it("round-trips a dismissal and its optional reason", () => {
    const req = { reason: "Not worth it" };
    expect(FactoryDismissRequest.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
    expect(FactoryDismissRequest.parse({})).toEqual({});
    expect(FactoryDismissRequest.safeParse({ reason: " " }).success).toBe(false);
  });
});
