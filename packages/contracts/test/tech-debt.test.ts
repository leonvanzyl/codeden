import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  TechDebtAction,
  TechDebtActionResult,
  TechDebtIssue,
  TechDebtView,
} from "../src";

describe("project tech debt contracts", () => {
  it("round-trips the append-only view and accepts only qualified issue references", () => {
    const view = TechDebtView.parse({
      projectId: "p",
      issue: "owner/repo#246",
      imported: false,
      findings: [],
    });
    expect(
      EventEnvelope.parse({
        seq: 1,
        ts: "2026-11-23T00:00:00.000Z",
        sessionId: null,
        type: "tech_debt.updated",
        payload: { view },
      }).payload,
    ).toEqual({ view });
    expect(TechDebtIssue.safeParse("repo#246").success).toBe(false);
    expect(TechDebtIssue.safeParse("owner/repo#0").success).toBe(false);
  });

  it("requires a reason for dismissal and distinct selections for a fix", () => {
    expect(TechDebtAction.safeParse({ action: "dismiss", id: "f", reason: " " }).success).toBe(
      false,
    );
    expect(TechDebtAction.safeParse({ action: "fix", ids: ["f", "f"] }).success).toBe(false);
  });

  it("round-trips a synchronization warning without adding it to the durable view", () => {
    const view = { projectId: "p", issue: "owner/repo#246", imported: true, findings: [] };
    const result = { ...view, syncError: "The issue could not be synchronized." };
    expect(TechDebtActionResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(TechDebtView.parse(result)).toEqual(view);
  });
});
