import { describe, expect, it } from "vitest";
import {
  CreateGroupRequest,
  EventEnvelope,
  GroupMemoryResponse,
  nextMemoryContent,
  Project,
  ProjectGroup,
  renderSkillFile,
  SessionOptions,
  Snapshot,
  UpdateProjectRequest,
  WriteGroupMemoryRequest,
} from "../src";
import { sampleProject, ts } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const skill = {
  name: "deploy-notes",
  description: 'Use when deploying: "prod" first',
  body: "Run it.",
};
const group = {
  id: "g1",
  name: "Storefront",
  description: null,
  skills: [skill],
  createdAt: ts,
  updatedAt: ts,
};

describe("project groups", () => {
  it("round-trips a group and its events", () => {
    expect(roundTrip(ProjectGroup, group)).toEqual(group);
    for (const event of [
      { type: "project_group.saved", payload: { group } },
      { type: "project_group.deleted", payload: { groupId: "g1" } },
      {
        type: "project_group.memory_written",
        payload: {
          groupId: "g1",
          mode: "append",
          content: "Shared CDN: fastly",
          revision: 3,
          by: { sessionId: "s1", projectId: "p1" },
        },
      },
    ]) {
      roundTrip(EventEnvelope, { seq: 1, sessionId: null, ts, ...event });
    }
    roundTrip(GroupMemoryResponse, {
      memory: { groupId: "g1", content: "x\n", revision: 1, updatedAt: ts },
    });
  });

  it("refuses duplicate skill names and bad folder names", () => {
    expect(CreateGroupRequest.safeParse({ name: "A", skills: [skill, skill] }).success).toBe(false);
    expect(
      CreateGroupRequest.safeParse({ name: "A", skills: [{ ...skill, name: "../x" }] }).success,
    ).toBe(false);
  });

  it("reads projects, snapshots and requests written before groups existed", () => {
    const { groupId: _groupId, ...old } = sampleProject;
    expect(Project.parse(old).groupId).toBeNull();
    expect(roundTrip(Project, { ...sampleProject, groupId: "g1" }).groupId).toBe("g1");
    expect(UpdateProjectRequest.parse({ groupId: null })).toEqual({ groupId: null });
    expect(WriteGroupMemoryRequest.parse({ content: "x" }).mode).toBe("replace");
    const options = SessionOptions.parse({
      sessionId: "s1",
      role: "agent",
      cwd: "/w",
      autonomy: "auto",
    });
    expect(options.sharedSkills).toBeUndefined();
    const snapshot = Snapshot.shape.groups.parse(undefined);
    expect(snapshot).toEqual([]);
  });

  it("renders a skill as SKILL.md with front matter that survives quotes", () => {
    const { name, content } = renderSkillFile(skill);
    expect(name).toBe("deploy-notes");
    expect(content).toBe(
      '---\nname: deploy-notes\ndescription: "Use when deploying: \\"prod\\" first"\n---\n\nRun it.\n',
    );
  });

  it("appends with a blank line and replaces outright", () => {
    expect(nextMemoryContent("", "a", "append")).toBe("a\n");
    expect(nextMemoryContent("a\n\n", " b ", "append")).toBe("a\n\nb\n");
    expect(nextMemoryContent("a\n", "c", "replace")).toBe("c\n");
    expect(nextMemoryContent("a\n", "  ", "replace")).toBe("");
  });
});
