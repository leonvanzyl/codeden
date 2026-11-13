import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ItemRecord, type Role, ThreadItemsPage } from "@codeden/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { NoticeStore } from "../src/services/orchestration/notices";
import { Reminders } from "../src/services/orchestration/reminders";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const MIN = 60_000;

describe("scheduled wake-ups (§8.2)", () => {
  let dir: string;
  let database: Database;
  let notices: NoticeStore;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    dir = mkdtempSync(join(tmpdir(), "codeden-wakeups-"));
    database = openDatabase(join(dir, "codeden.db"));
    notices = new NoticeStore(database.db, new EventStore(database.db));
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const reminders = () => {
    const request = vi.fn();
    const r = new Reminders({ notices, wakes: { request } });
    r.start();
    return { r, request };
  };
  const pm = { target: "pm" as const, projectId: "p1", sessionId: "pm1" };

  it("holds a wake-up back until it is due, then wakes its owner with the note", async () => {
    const { r, request } = reminders();
    const due = new Date(NOW + 5 * MIN);
    const reminder = r.schedule(pm, due, "Check whether the audit finished");
    expect(reminder.notBefore).toBe(due.toISOString());
    expect(notices.undelivered("pm", "p1")).toEqual([]);
    expect(r.pending("pm", "p1").map((n) => n.id)).toEqual([reminder.id]);

    await vi.advanceTimersByTimeAsync(5 * MIN - 1_000);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledWith("pm:p1");
    expect(notices.undelivered("pm", "p1").map((n) => n.id)).toEqual([reminder.id]);
    r.dispose();
  });

  it("survives a restart: a new scheduler arms itself from the stored wake-ups", async () => {
    const first = reminders();
    first.r.schedule(
      { target: "orchestrator", projectId: null, sessionId: "o1" },
      new Date(NOW + 30 * MIN),
      "Ask the PMs",
    );
    first.r.dispose();

    const second = reminders();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(second.request).toHaveBeenCalledWith("orchestrator");
    expect(first.request).not.toHaveBeenCalled();
    second.r.dispose();
  });

  it("cancels a wake-up, and only its owner's", async () => {
    const { r, request } = reminders();
    const mine = r.schedule(pm, new Date(NOW + 2 * MIN), "Follow up");
    expect(r.cancel("pm", "p2", mine.id)).toBe(false);
    expect(r.cancel("pm", "p1", mine.id)).toBe(true);
    expect(r.pending("pm", "p1")).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(request).not.toHaveBeenCalled();
    expect(r.cancel("pm", "p1", mine.id)).toBe(false);
    r.dispose();
  });

  it("limits how far ahead and how many", () => {
    const { r } = reminders();
    expect(() => r.schedule(pm, new Date(NOW + 10_000), "Too soon")).toThrow(/at least/);
    expect(() => r.schedule(pm, new Date(NOW + 8 * 24 * 60 * MIN), "Too late")).toThrow(/7 days/);
    for (let i = 0; i < 20; i += 1) r.schedule(pm, new Date(NOW + (i + 2) * MIN), `n${i}`);
    expect(() => r.schedule(pm, new Date(NOW + 60 * MIN), "One more")).toThrow(/20/);
    // Another owner has its own allowance.
    expect(() =>
      r.schedule({ ...pm, projectId: "p2" }, new Date(NOW + 60 * MIN), "Elsewhere"),
    ).not.toThrow();
    r.dispose();
  });
});

describe("schedule_wakeup, list_wakeups and cancel_wakeup", () => {
  let h: Harness;
  const call = (
    role: Role,
    name: string,
    args: unknown,
    sessionId: string,
    projectId: string | null,
  ) =>
    h.server.services.tools.call(name, args, {
      role,
      sessionId,
      projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });

  beforeAll(async () => {
    h = await startHarness({
      orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 }, wakeupMinDelayMs: 0 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const items = async (sessionId: string): Promise<ItemRecord[]> => {
    const d = await h.detail(sessionId);
    if (!d.session.rootThreadId) return [];
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${d.session.rootThreadId}/items?limit=500`,
    );
    return ThreadItemsPage.parse(res.body).items;
  };

  it("lets the PM schedule, list and cancel its own wake-ups", async () => {
    const PM = "pm-wakeups";
    const scheduled = await call(
      "pm",
      "schedule_wakeup",
      { inMinutes: 30, note: "Check the audit" },
      PM,
      h.projectId,
    );
    expect(scheduled.isError).toBe(false);
    const listed = JSON.parse((await call("pm", "list_wakeups", {}, PM, h.projectId)).text);
    expect(listed.wakeups).toHaveLength(1);
    expect(listed.wakeups[0]).toMatchObject({ note: "Check the audit" });
    const id = listed.wakeups[0].id as string;
    // Neither both nor neither of inMinutes and at.
    const both = await call(
      "pm",
      "schedule_wakeup",
      { inMinutes: 5, at: new Date().toISOString(), note: "x" },
      PM,
      h.projectId,
    );
    expect(both.isError).toBe(true);
    // The orchestrator can't cancel the PM's.
    const theirs = await call("orchestrator", "cancel_wakeup", { id }, "orch", null);
    expect(theirs.isError).toBe(true);
    const cancelled = await call("pm", "cancel_wakeup", { id }, PM, h.projectId);
    expect(cancelled.isError).toBe(false);
    expect(
      JSON.parse((await call("pm", "list_wakeups", {}, PM, h.projectId)).text).wakeups,
    ).toEqual([]);
  });

  it("wakes the orchestrator with its note when the time comes", async () => {
    const at = new Date(Date.now() + 500).toISOString();
    const res = await call(
      "orchestrator",
      "schedule_wakeup",
      { at, note: "Ask the shop PM whether the release is ready" },
      "orch",
      null,
    );
    expect(res.isError).toBe(false);
    const orchestrator = await waitUntil(
      () => h.server.services.orchestration.roles.find("orchestrator", null),
      20_000,
    );
    const user = await waitUntil(async () => {
      const found = (await items(orchestrator.id)).find(
        (r) =>
          r.item.kind === "user_message" &&
          r.item.input.text.includes("Ask the shop PM whether the release is ready"),
      );
      return found;
    });
    expect(user).toBeTruthy();
  });
});
