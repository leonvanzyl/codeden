import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { showsProject } from "../src/lib/project-pages";

const sessions = [{ id: "s1" }, { id: "s2" }] as Session[];

describe("showsProject", () => {
  it("is true on the project's own pages and sessions", () => {
    expect(showsProject("/projects/p1", "p1", sessions)).toBe(true);
    expect(showsProject("/projects/p1/pm", "p1", sessions)).toBe(true);
    expect(showsProject("/sessions/s2", "p1", sessions)).toBe(true);
  });

  it("is false elsewhere, including a project whose id starts the same", () => {
    expect(showsProject("/", "p1", sessions)).toBe(false);
    expect(showsProject("/projects/p10", "p1", sessions)).toBe(false);
    expect(showsProject("/projects/p2/pm", "p1", sessions)).toBe(false);
    expect(showsProject("/sessions/s9", "p1", sessions)).toBe(false);
  });
});
