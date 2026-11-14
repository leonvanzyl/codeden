import { describe, expect, it } from "vitest";
import { FactoryRetryOptions, FactoryRetryRequest, type StoppedItem, stoppedRetry } from "../src";

const pr = { number: 172, url: "https://github.com/acme/app/pull/172", state: "open" as const };
const failed: StoppedItem = {
  stage: "failed",
  pr,
  failureKind: "checks",
  attempts: 2,
  reason: "review: request_changes: still has gaps",
};

describe("retrying stopped factory work (#259)", () => {
  it("round-trips a retry request: the item, and an optional re-review or rebuild", () => {
    const req = FactoryRetryRequest.parse({ itemId: "item-1", mode: "rereview" });
    expect(FactoryRetryRequest.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
    // Without a mode the server picks: a re-review while the item's PR is open.
    expect(FactoryRetryRequest.parse({ itemId: "item-1" }).mode).toBeUndefined();
    expect(FactoryRetryOptions.parse({})).toEqual({});
    expect(FactoryRetryOptions.parse({ mode: "rebuild" }).mode).toBe("rebuild");
    expect(FactoryRetryRequest.safeParse({ itemId: "item-1", mode: "merge" }).success).toBe(false);
    expect(FactoryRetryRequest.safeParse({ mode: "rereview" }).success).toBe(false);
  });

  it("re-reviews a failed item's open PR, and says what it needs", () => {
    expect(stoppedRetry(failed)).toEqual({
      mode: "rereview",
      pr,
      label: "Stopped after 2 revise rounds; needs a re-review (Retry)",
    });
    expect(stoppedRetry({ ...failed, attempts: 1 })?.label).toMatch(/after 1 revise round;/);
    expect(stoppedRetry({ ...failed, pr: { ...pr, state: "draft" } })?.mode).toBe("rereview");
  });

  it("rebuilds without an open PR, and labels only what needs a re-review", () => {
    const closed = { ...failed, pr: { ...pr, state: "closed" as const } };
    expect(stoppedRetry(closed)).toEqual({ mode: "rebuild", pr: null, label: null });
    expect(stoppedRetry({ ...failed, pr: null })?.mode).toBe("rebuild");
    // Stuck work is in the inbox, and work over the size limit waits on the PM.
    expect(stoppedRetry({ ...failed, failureKind: "stuck" })).toMatchObject({
      mode: "rereview",
      label: null,
    });
    const tooLarge = { ...failed, reason: "ci: failed; size: 6,000 lines in 2 files" };
    expect(stoppedRetry(tooLarge)?.label).toBeNull();
    expect(stoppedRetry({ ...failed, stage: "rejected" })?.label).toBeNull();
  });

  it("offers nothing for work that hasn't stopped", () => {
    for (const stage of ["verifying", "escalated", "merged", "backlog"] as const) {
      expect(stoppedRetry({ ...failed, stage })).toBeNull();
    }
  });
});
