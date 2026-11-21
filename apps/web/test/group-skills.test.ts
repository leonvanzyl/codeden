import type { ProjectGroup, Snapshot } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { hasErrors, skillErrors } from "../src/lib/group-skills";
import { applyDomainEvent } from "../src/lib/snapshot-reducer";

const skill = { name: "release-notes", description: "Write release notes", body: "Do it." };

describe("skillErrors", () => {
  it("accepts a valid skill", () => {
    expect(hasErrors(skillErrors(skill, ["other"]))).toBe(false);
  });

  it("rejects names that aren't lowercase-hyphen, empty or taken", () => {
    expect(skillErrors({ ...skill, name: "Release Notes" }, []).name).toBeTruthy();
    expect(skillErrors({ ...skill, name: "" }, []).name).toBeTruthy();
    expect(skillErrors({ ...skill, name: "a".repeat(65) }, []).name).toBeTruthy();
    expect(skillErrors(skill, ["release-notes"]).name).toMatch(/Another skill/);
  });

  it("requires a description", () => {
    expect(skillErrors({ ...skill, description: "  " }, []).description).toBeTruthy();
  });
});

const group = (id: string, name: string): ProjectGroup => ({
  id,
  name,
  description: null,
  skills: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snap = (groups: ProjectGroup[]) => ({ seq: 1, groups }) as unknown as Snapshot;
const env = (seq: number, type: string, payload: unknown) =>
  ({ seq, ts: "2026-01-01T00:00:00.000Z", sessionId: null, type, payload }) as never;

describe("snapshot groups", () => {
  it("upserts saved groups, sorted by name then id", () => {
    let s = snap([group("g2", "Beta")]);
    s = applyDomainEvent(s, env(2, "project_group.saved", { group: group("g1", "Alpha") }));
    s = applyDomainEvent(s, env(3, "project_group.saved", { group: group("g3", "Beta") }));
    expect(s.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    s = applyDomainEvent(s, env(4, "project_group.saved", { group: group("g1", "Zed") }));
    expect(s.groups.map((g) => g.name)).toEqual(["Beta", "Beta", "Zed"]);
  });

  it("removes deleted groups and ignores memory writes", () => {
    let s = snap([group("g1", "Alpha"), group("g2", "Beta")]);
    s = applyDomainEvent(s, env(2, "project_group.deleted", { groupId: "g1" }));
    expect(s.groups.map((g) => g.id)).toEqual(["g2"]);
    const before = s.groups;
    s = applyDomainEvent(
      s,
      env(3, "project_group.memory_written", {
        groupId: "g2",
        mode: "replace",
        content: "x",
        revision: 1,
        by: { sessionId: null, projectId: null },
      }),
    );
    expect(s.groups).toBe(before);
  });
});
