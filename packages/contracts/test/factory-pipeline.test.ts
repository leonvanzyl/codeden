import { describe, expect, it } from "vitest";
import {
  AutonomyMode,
  FactoryAnalysisReport,
  FactoryFileIssueRequest,
  FactoryLimits,
  type Investigation,
  Project,
  pipelineStep,
  ScoutState,
} from "../src";
import { sampleProject, ts } from "./fixtures";

const base = {
  stage: "building",
  type: "bug" as const,
  investigation: null as Investigation | null,
  checks: [] as Array<{ state: string }>,
  review: null,
};
const reproduced: Investigation = {
  kind: "reproduction",
  outcome: "reproduced",
  summary: "Throws",
  details: null,
  testPath: "test/a.test.ts",
  at: ts,
};

describe("factory pipelines (§10.1)", () => {
  it("reads the old `autopilot` mode as the software factory", () => {
    expect(AutonomyMode.parse("autopilot")).toBe("software_factory");
    expect(Project.parse({ ...sampleProject, autonomyMode: "autopilot" }).autonomyMode).toBe(
      "software_factory",
    );
    expect(AutonomyMode.safeParse("yolo").success).toBe(false);
  });

  it("defaults to manual merging and no trusted authors besides the GitHub account", () => {
    const limits = FactoryLimits.parse({});
    expect(limits.autoMerge).toBe(false);
    expect(limits.trustedAuthors).toEqual([]);
    expect(FactoryLimits.parse({ trustedAuthors: ["@octocat"] }).trustedAuthors).toEqual([
      "octocat",
    ]);
  });

  it("puts each item at its pipeline step", () => {
    expect(pipelineStep({ ...base, stage: "candidate" })).toBe("intake");
    expect(pipelineStep({ ...base, stage: "ignored" })).toBe("ignored");
    expect(pipelineStep({ ...base, stage: "backlog" })).toBe("queued");
    expect(pipelineStep(base)).toBe("reproduce");
    expect(pipelineStep({ ...base, type: "feature" })).toBe("analyze");
    expect(pipelineStep({ ...base, type: "docs" })).toBe("implement");
    expect(pipelineStep({ ...base, investigation: reproduced })).toBe("implement");
    const verifying = { ...base, stage: "verifying", investigation: reproduced };
    expect(pipelineStep({ ...verifying, checks: [{ state: "pending" }] })).toBe("review");
    expect(pipelineStep({ ...verifying, checks: [{ state: "fail" }] })).toBe("review");
    expect(pipelineStep({ ...verifying, checks: [{ state: "pass" }, { state: "skipped" }] })).toBe(
      "merge",
    );
    expect(pipelineStep({ ...base, stage: "escalated" })).toBe("merge");
    expect(pipelineStep({ ...base, stage: "merged" })).toBe("done");
    expect(pipelineStep({ ...base, stage: "failed" })).toBe("stopped");
  });

  it("validates the builder's and the scout's reports", () => {
    expect(
      FactoryAnalysisReport.safeParse({ decision: "implement", summary: "Missing" }).success,
    ).toBe(false);
    expect(
      FactoryAnalysisReport.safeParse({ decision: "out_of_scope", summary: "Not for us" }).success,
    ).toBe(true);
    const filed = FactoryFileIssueRequest.parse({
      title: "Add CSV export",
      summary: "Users ask for it",
      type: "feature",
      acceptanceCriteria: ["Exports"],
    });
    expect(filed.priority).toBe("normal");
    expect(FactoryFileIssueRequest.safeParse({ ...filed, type: "chore" }).success).toBe(false);
    expect(ScoutState.parse({}).lensSessions).toEqual({});
  });
});
