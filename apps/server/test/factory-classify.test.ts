import { FactoryLimits } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyIssue,
  heuristicType,
  parseClassification,
  typeFromLabels,
} from "../src/services/factory/classify";
import {
  hasWriteAssociation,
  isTrustedAuthor,
  mayAutoMerge,
  trustedLogins,
} from "../src/services/factory/trust";

describe("trusted authors (§10.1)", () => {
  const limits = FactoryLimits.parse({ trustedAuthors: ["Alice", "@bob"] });

  it("trusts the listed logins and the GitHub account, case-insensitively, and nobody else", () => {
    const trusted = trustedLogins(limits, "Owner");
    expect(isTrustedAuthor("alice", trusted)).toBe(true);
    expect(isTrustedAuthor("BOB", trusted)).toBe(true);
    expect(isTrustedAuthor("owner", trusted)).toBe(true);
    expect(isTrustedAuthor("mallory", trusted)).toBe(false);
    expect(isTrustedAuthor(null, trusted)).toBe(false);
    expect(isTrustedAuthor("owner", trustedLogins(limits, null))).toBe(false);
  });

  it("counts owners, organization members and collaborators as having write access", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(hasWriteAssociation(a)).toBe(true);
    for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", null]) {
      expect(hasWriteAssociation(a)).toBe(false);
    }
  });

  it("rejects things that are not GitHub logins", () => {
    expect(FactoryLimits.safeParse({ trustedAuthors: ["not a login"] }).success).toBe(false);
    expect(FactoryLimits.safeParse({ trustedAuthors: ["renovate[bot]"] }).success).toBe(true);
  });

  it("auto-merges only trusted work, and only with auto-merge on", () => {
    expect(mayAutoMerge({ trust: "trusted" }, { autoMerge: true })).toBe(true);
    expect(mayAutoMerge({ trust: "admitted" }, { autoMerge: true })).toBe(false);
    expect(mayAutoMerge({ trust: "untrusted" }, { autoMerge: true })).toBe(false);
    expect(mayAutoMerge({ trust: "trusted" }, { autoMerge: false })).toBe(false);
    expect(FactoryLimits.parse({}).autoMerge).toBe(false);
  });
});

describe("Identify type (§10.1)", () => {
  it("reads one type from labels and ignores conflicting ones", () => {
    expect(typeFromLabels(["bug"])).toBe("bug");
    expect(typeFromLabels(["Type: Enhancement", "good first issue"])).toBe("feature");
    expect(typeFromLabels(["documentation"])).toBe("docs");
    expect(typeFromLabels(["factory:docs"])).toBe("docs");
    expect(typeFromLabels(["bug", "enhancement"])).toBeNull();
    expect(typeFromLabels(["debug-mode"])).toBeNull();
  });

  it("falls back to keywords", () => {
    expect(heuristicType("Fix typo in README", "").type).toBe("docs");
    expect(heuristicType("App crashes on save", "").type).toBe("bug");
    expect(heuristicType("Add CSV export", "It would be nice").type).toBe("feature");
  });

  it("parses the model's answer and refuses anything else", () => {
    expect(
      parseClassification('Sure: {"type":"bug","confidence":"high","rationale":"It throws"}'),
    ).toEqual({ type: "bug", confidence: "high", rationale: "It throws" });
    expect(parseClassification('{"type":"feature"}')?.confidence).toBe("medium");
    expect(parseClassification('{"type":"delete-repo"}')).toBeNull();
    expect(parseClassification("bug")).toBeNull();
    expect(parseClassification(null)).toBeNull();
  });

  it("uses a label first, then the model, then keywords", async () => {
    const now = new Date();
    const model = async () => '{"type":"docs","confidence":"medium","rationale":"Only docs"}';
    const labelled = await classifyIssue({ title: "x", body: "", labels: ["bug"] }, model, now);
    expect(labelled).toMatchObject({ type: "bug", by: "label" });
    const modelled = await classifyIssue({ title: "x", body: "", labels: [] }, model, now);
    expect(modelled).toMatchObject({ type: "docs", by: "model" });
    const guessed = await classifyIssue(
      { title: "Crash on start", body: "", labels: [] },
      async () => null,
      now,
    );
    expect(guessed).toMatchObject({ type: "bug", by: "heuristic", confidence: "low" });
  });
});
