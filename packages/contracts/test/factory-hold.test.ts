import { describe, expect, it } from "vitest";
import {
  FACTORY_HOLD_LABEL,
  FactoryHeldIssue,
  FactoryHold,
  FactoryHoldRequest,
  FactoryHoldResult,
  FactoryItem,
  FactoryLoop,
  FactoryReleaseRequest,
  FactoryStatus,
  FactoryStop,
  factoryStopReason,
} from "../src";

const at = "2026-11-23T10:00:00.000Z";
const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

describe("holding work out of the factory loop (#593)", () => {
  it("round-trips the hold and release requests: an issue and an optional reason", () => {
    const hold = FactoryHoldRequest.parse({ issueNumber: 12, reason: "  waiting on #11 " });
    expect(hold).toEqual({ issueNumber: 12, reason: "waiting on #11" });
    roundTrip(FactoryHoldRequest, hold);
    expect(FactoryHoldRequest.parse({ issueNumber: 12 }).reason).toBeUndefined();
    roundTrip(FactoryReleaseRequest, FactoryReleaseRequest.parse({ issueNumber: 12 }));
    expect(FactoryHoldRequest.safeParse({ issueNumber: 0 }).success).toBe(false);
    expect(FactoryHoldRequest.safeParse({ issueNumber: 12, reason: " " }).success).toBe(false);
    expect(FactoryHoldRequest.safeParse({ issueNumber: 12, reason: "x".repeat(501) }).success).toBe(
      false,
    );
  });

  it("round-trips a hold record, a held issue, a result and a stop", () => {
    roundTrip(FactoryHold, { issueNumber: 12, reason: "waiting on #11", by: "pm", at });
    roundTrip(FactoryHeldIssue, {
      issue: { number: 12, url: "https://github.com/acme/app/issues/12", title: "Add export" },
      itemId: null,
      kind: "label",
      reason: null,
      by: null,
      since: null,
    });
    roundTrip(FactoryHeldIssue, {
      issue: { number: 12, url: "https://github.com/acme/app/issues/12", title: "Add export" },
      itemId: "item-1",
      kind: "recorded",
      reason: "waiting on #11",
      by: "pm",
      since: at,
    });
    expect(
      FactoryHeldIssue.safeParse({
        issue: { number: 12, url: "https://github.com/acme/app/issues/12", title: "Add export" },
        itemId: null,
        reason: null,
        by: null,
        since: null,
      }).success,
    ).toBe(false);
    roundTrip(FactoryHoldResult, {
      issueNumber: 12,
      held: true,
      itemId: "item-1",
      stage: "backlog",
      message: "Held: parked in the queue until it is released.",
    });
    const stop = { sessionId: "s-1", reason: "superseded by #14", by: "pm" as const, at };
    roundTrip(FactoryStop, stop);
    expect(FactoryStop.safeParse({ ...stop, reason: "" }).success).toBe(false);
    expect(factoryStopReason(stop)).toBe("Stopped by the PM: superseded by #14");
    expect(FACTORY_HOLD_LABEL).toBe("factory:hold");
  });

  it("reads items, loops and statuses saved before holds existed", () => {
    const item = FactoryItem.parse({
      id: "item-1",
      projectId: "p-1",
      workKey: "issue:12",
      title: "Add export",
      summary: "",
      source: "issue",
      area: null,
      acceptanceCriteria: [],
      score: null,
      stage: "backlog",
      issue: null,
      pr: null,
      builderSessionId: null,
      builderProvider: null,
      reviewerSessionId: null,
      reviewerProvider: null,
      reviewerNote: null,
      review: null,
      checks: [],
      attempts: 0,
      reason: null,
      note: null,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      createdAt: at,
      updatedAt: at,
      mergedAt: null,
      finishedAt: null,
    });
    expect(item.stop).toBeNull();
    roundTrip(FactoryItem, { ...item, stop: { sessionId: "s-1", reason: "held", by: "pm", at } });
    const loop = FactoryLoop.parse({
      projectId: "p-1",
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-23",
      mergesToday: 0,
      lastDigestDay: null,
      enabledAt: null,
      lastTickAt: null,
      updatedAt: at,
    });
    expect(loop.holds).toEqual([]);
    roundTrip(FactoryLoop, { ...loop, holds: [{ issueNumber: 12, reason: null, by: "pm", at }] });
    expect(FactoryStatus.shape.held.parse(undefined)).toEqual([]);
  });
});
