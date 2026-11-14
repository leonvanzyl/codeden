import { describe, expect, it } from "vitest";
import { Project, UpdateProjectRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// #261: a project's default agent (provider, model, effort) for new sessions.
describe("A project's default model and effort", () => {
  it("are null for projects written before they existed", () => {
    const { defaultModel: _m, defaultEffort: _e, ...rest } = sampleProject;
    expect(Project.parse(rest)).toMatchObject({ defaultModel: null, defaultEffort: null });
  });

  it("round-trip on a project", () => {
    const project = roundTrip(Project, {
      ...sampleProject,
      defaultProvider: "claude",
      defaultModel: "opus",
      defaultEffort: "high",
    });
    expect(project).toMatchObject({
      defaultProvider: "claude",
      defaultModel: "opus",
      defaultEffort: "high",
    });
    expect(Project.safeParse({ ...sampleProject, defaultEffort: "extreme" }).success).toBe(false);
  });

  it("are changed and cleared through the project update request", () => {
    const set = { defaultProvider: "claude", defaultModel: "opus", defaultEffort: "high" };
    expect(roundTrip(UpdateProjectRequest, set)).toEqual(set);
    const cleared = { defaultProvider: null, defaultModel: null, defaultEffort: null };
    expect(roundTrip(UpdateProjectRequest, cleared)).toEqual(cleared);
    expect(UpdateProjectRequest.safeParse({ defaultModel: "" }).success).toBe(false);
    expect(UpdateProjectRequest.safeParse({ defaultEffort: "extreme" }).success).toBe(false);
  });
});
