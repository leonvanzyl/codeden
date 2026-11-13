import type { ProjectStatus } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import type { ServerToolContext } from "../src/mcp/define";
import { listWakeups, scheduleWakeup } from "../src/mcp/tools/wakeups";
import { renderOverviewDigest, renderProjectDigest } from "../src/services/orchestration/digest";
import { rolePrompt } from "../src/services/orchestration/prompts";

/**
 * #207: the PM and the orchestrator get every time in UTC and nothing tells them the user's
 * timezone, so they quote UTC clock times to a user at UTC+2.
 */

const NOW = Date.parse("2026-11-13T19:54:36.000Z");
const TZ = "Africa/Johannesburg";

const status: ProjectStatus = {
  project: { id: "p1", name: "Shop", kind: "local", mode: "assisted" },
  running: [],
  queued: [],
  scheduled: [],
  inbox: { open: 0, items: [] },
  recent: [],
};

describe("local time for the PM and the orchestrator (#207)", () => {
  it("stamps the PM digest with the user's timezone and local time", () => {
    expect(renderProjectDigest(status, NOW, TZ)).toContain(
      '<codeden_status project="Shop" mode="assisted" at="2026-11-13T19:54:36.000Z" tz="Africa/Johannesburg" local="2026-11-13 21:54">',
    );
  });

  it("stamps the orchestrator digest with the user's timezone and local time", () => {
    const text = renderOverviewDigest(
      {
        generatedAt: new Date(NOW).toISOString(),
        projects: [status],
        sharedWork: [],
        pmMessages: [],
      },
      NOW,
      TZ,
    );
    expect(text).toContain(
      '<codeden_status scope="all projects" at="2026-11-13T19:54:36.000Z" tz="Africa/Johannesburg" local="2026-11-13 21:54">',
    );
  });

  it("tells both roles to quote times in the user's local time", () => {
    for (const role of ["pm", "orchestrator"] as const) {
      expect(rolePrompt(role)).toContain(
        "Times you tell the user are in their local time (the digest's `tz` and `local`).",
      );
    }
  });

  it("shows a wake-up's local time next to UTC", async () => {
    const at = "2026-11-13T20:30:00.000Z";
    const ctx = {
      role: "pm",
      projectId: "p1",
      sessionId: "pm1",
      services: {
        orchestration: {
          timezone: () => TZ,
          reminders: {
            schedule: (_owner: unknown, when: Date) => ({
              id: "w1",
              notBefore: when.toISOString(),
            }),
            pending: () => [
              { type: "reminder", id: "w1", notBefore: at, data: { note: "Check the audit" } },
            ],
          },
        },
      },
    } as unknown as ServerToolContext<"session">;

    const scheduled = String(await scheduleWakeup.handler({ at, note: "Check the audit" }, ctx));
    expect(scheduled).toContain(at);
    expect(scheduled).toContain("22:30");
    expect(scheduled).toContain(TZ);

    const listed = JSON.stringify(await listWakeups.handler({}, ctx));
    expect(listed).toContain(at);
    expect(listed).toContain("22:30");
  });
});
