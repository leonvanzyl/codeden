import { describe, expect, it } from "vitest";
import { Project, SessionOptions, UpdateProjectRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// #221: agent sessions run with `CI=true` (#194), which changes how the user's own tools behave.
// A project setting, on by default, turns it off for that project's agent sessions.
describe("CI=true in agent sessions, per project", () => {
  it("is on by default, so projects written before the setting existed keep CI=true", () => {
    const { agentCiEnv: _a, ...rest } = sampleProject;
    expect(Project.parse(rest).agentCiEnv).toBe(true);
  });

  it("round-trips a project that turned it off", () => {
    expect(roundTrip(Project, { ...sampleProject, agentCiEnv: false }).agentCiEnv).toBe(false);
    expect(Project.safeParse({ ...sampleProject, agentCiEnv: "off" }).success).toBe(false);
  });

  it("is changed through the project update request", () => {
    expect(roundTrip(UpdateProjectRequest, { agentCiEnv: false })).toEqual({ agentCiEnv: false });
    expect(UpdateProjectRequest.safeParse({ agentCiEnv: "no" }).success).toBe(false);
  });

  it("reaches the runner in the session options (absent means on)", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/r", autonomy: "auto" };
    expect(SessionOptions.parse(base).ciEnv).toBeUndefined();
    expect(roundTrip(SessionOptions, { ...base, ciEnv: false }).ciEnv).toBe(false);
    expect(SessionOptions.safeParse({ ...base, ciEnv: "false" }).success).toBe(false);
  });
});
