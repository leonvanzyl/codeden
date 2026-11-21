import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { sessionsKeepingLevel } from "@/lib/project-permissions";

const session = (id: string, over: Partial<Session> = {}) =>
  makeSession({
    id,
    role: "agent",
    status: "running",
    provider: "fake",
    purpose: id,
    workKey: `request:${id}`,
    projectId: "p1",
    autonomy: "supervised",
    ...over,
  });

describe("sessionsKeepingLevel", () => {
  it("names the project's open agent sessions on another level", () => {
    const sessions = [
      session("s-running"),
      session("s-idle", { status: "idle", autonomy: "full" }),
      session("s-same", { autonomy: "auto" }),
      session("s-other-project", { projectId: "p2" }),
      session("s-pm", { role: "pm" }),
      session("s-archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      session("s-stopped", { status: "stopped" }),
      session("s-completed", { status: "completed" }),
      session("s-failed", { status: "failed" }),
    ];
    expect(sessionsKeepingLevel(sessions, "p1", "auto").map((s) => s.id)).toEqual([
      "s-running",
      "s-idle",
    ]);
  });

  it("names none once the sessions are on the project's level", () => {
    expect(sessionsKeepingLevel([session("s1")], "p1", "supervised")).toEqual([]);
  });
});
