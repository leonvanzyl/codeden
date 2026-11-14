import { describe, expect, it } from "vitest";
import { stoppedAction, stoppedKind, stoppedLabel } from "@/components/factory/stopped-items";
import { repairBay } from "@/components/factory-view/pixel/repair-bay";
import { viewPipeline } from "@/components/factory-view/stages";
import { minutesAgo, NOW, prEntry, prRef, status, w } from "./pixel-fixtures";

/**
 * Issue #264 (with #259): stopped work says why it stopped and offers the right action, by one
 * shared rule; the pixel repair bay groups it into a few crates with counts.
 */

const failed = (id: string, n: number, patch: Parameters<typeof w>[2]) =>
  w(id, n, { stage: "failed", step: "stopped", finishedAt: minutesAgo(30), ...patch });

const rounds = failed("rounds", 1, { pr: prRef(11), attempts: 2, failureKind: "checks" });
const rebuilt = failed("rebuilt", 2, {
  pr: prRef(12),
  failureKind: "stuck",
  reason: "Rebuilt once and still conflicting with main",
});
const noCi = failed("no-ci", 3, {
  pr: prRef(13),
  failureKind: "stuck",
  reason: "CI never starts: GitHub Actions is off for this repository",
});
const noPr = failed("no-pr", 4, { reason: "The builder never reported" });
const escalated = w("protected", 5, {
  stage: "escalated",
  step: "merge",
  pr: prRef(15),
  reason: "Touches a protected area (src/payments): yours to merge",
});
const yours = w("yours", 6, { stage: "verifying", step: "merge", pr: prRef(16) });
const live = w("live", 7, { stage: "building", step: "implement" });

describe("stopped items (#264)", () => {
  it("says why each kind of work stopped", () => {
    const rows = [
      [rounds, null],
      [rebuilt, null],
      [noCi, null],
      [noPr, null],
      [escalated, null],
      [yours, prEntry("yours", 16, { state: "waiting_for_you", note: "auto-merge is off" })],
      [live, null],
    ] as const;
    expect(
      rows.map(([item, pr]) => [
        item.id,
        stoppedKind(item, pr),
        stoppedLabel(item, pr),
        stoppedAction(item, pr),
      ]),
    ).toEqual([
      ["rounds", "retry", "Stopped after 2 revise rounds; needs a re-review", "retry"],
      ["rebuilt", "stuck", "Rebuilt once and still conflicting", "retry"],
      ["no-ci", "stuck", "CI can't run on this repository", "retry"],
      ["no-pr", "retry", "Stopped without a pull request", "retry"],
      ["protected", "merge", "Yours to merge: protected area", "open_pr"],
      ["yours", "merge", "Yours to merge: auto-merge is off", "open_pr"],
      ["live", null, null, null],
    ]);
  });

  it("reads a rebuild's open original PR as its own", () => {
    const rebuild = failed("rebuild", 8, {
      pr: null,
      ownedPr: prRef(18),
      attempts: 1,
      failureKind: "checks",
    });
    expect(stoppedLabel(rebuild, null)).toBe("Stopped after 1 revise round; needs a re-review");
  });
});

describe("the repair bay (#264)", () => {
  it("groups what waits on a person into crates by kind, with counts", () => {
    const f = status({
      inProgress: [yours, live],
      recent: [rounds, rebuilt, noCi, noPr, escalated],
      pullRequests: [
        prEntry("yours", 16, { state: "waiting_for_you" }),
        prEntry("rebuilt", 12, { state: "stuck" }),
      ],
    });
    const bay = repairBay(viewPipeline(f, new Map(), NOW));
    expect(bay.map((c) => [c.kind, c.title, c.entries.map((e) => e.card.item.id)])).toEqual([
      ["retry", "Needs a retry", ["rounds", "no-pr"]],
      ["stuck", "Stuck", ["rebuilt", "no-ci"]],
      // Live work first, as the pipeline lists it.
      ["merge", "Yours to merge", ["yours", "protected"]],
    ]);
  });

  it("leaves agents that wait on an answer at their station, and is empty when nothing waits", () => {
    const asking = w("asking", 9, { activeSessionId: "s-ask" });
    const f = status({ inProgress: [asking, live] });
    const sessions = new Map([["s-ask", { status: "waiting" as const, progress: null }]]);
    expect(repairBay(viewPipeline(f, sessions, NOW))).toEqual([]);
  });

  it("takes in a stuck pull request that is still in a stage", () => {
    const stuck = w("stuck-pr", 10, { stage: "verifying", step: "merge", pr: prRef(20) });
    const f = status({
      inProgress: [stuck],
      pullRequests: [
        prEntry("stuck-pr", 20, { state: "stuck", note: "Rebuilt once and still conflicting" }),
      ],
    });
    const bay = repairBay(viewPipeline(f, new Map(), NOW));
    expect(bay.map((c) => [c.kind, c.entries.map((e) => [e.label, e.action])])).toEqual([
      ["stuck", [["Rebuilt once and still conflicting", null]]],
    ]);
  });
});
