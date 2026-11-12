import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AutomationListItem,
  AutomationListResponse,
  AutomationRun,
  AutomationTemplate,
  type Role,
  RunAutomationResponse,
  ScheduledRun,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const NOTES_FILE = [
  "---",
  "name: Notes reminder",
  "trigger:",
  "  type: manual",
  "action: message_pm",
  "---",
  "Review the project notes for {{project.name}}.",
].join("\n");

describe("automations (§10): scheduler, guards, runs, PM tools, files", () => {
  let h: Harness;
  let clock = new Date("2026-11-07T10:00:30Z");
  let auditId: string;
  const runs = async (automationId: string) =>
    AutomationRun.array().parse(
      (await h.api("GET", `/automations/runs?automationId=${automationId}`)).body,
    );
  const upcoming = async () =>
    ScheduledRun.array().parse(
      (await h.api("GET", `/automations/upcoming?projectId=${h.projectId}`)).body,
    );
  const list = async () =>
    AutomationListResponse.parse(
      (await h.api("GET", `/automations?projectId=${h.projectId}`)).body,
    );
  const pmTool = async (name: string, args: unknown) => {
    const res = await h.server.services.tools.call(name, args, {
      role: "pm" as Role,
      sessionId: "pm-test",
      projectId: h.projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });
    if (res.isError) throw new Error(res.text);
    return res.text.startsWith("{") ? (JSON.parse(res.text) as Record<string, unknown>) : res.text;
  };
  const tick = async (at: string) => {
    clock = new Date(at);
    await h.server.services.automations.scheduler.tick();
  };
  const create = async (body: Record<string, unknown>) => {
    const res = await h.api("POST", "/automations", { projectId: h.projectId, ...body });
    expect(res.status).toBe(201);
    return (res.body as AutomationListItem).automation.id;
  };

  beforeAll(async () => {
    h = await startHarness(
      {
        automations: { now: () => clock, rescanMs: 0 },
        orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 } },
        github: { sync: false },
      },
      { ".codeden/automations/notes-reminder.md": NOTES_FILE },
    );
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("lists the built-in templates and offers new projects the starter set, disabled", async () => {
    const templates = AutomationTemplate.array().parse(
      (await h.api("GET", "/automations/templates")).body,
    );
    expect(templates.map((t) => t.id)).toEqual(
      expect.arrayContaining(["security-audit", "ui-review", "issue-triage", "stale-pr-follow-up"]),
    );
    const listed = await waitUntil(async () => {
      const l = await list();
      return l.automations.some((i) => i.automation.source === "project_file") ? l : undefined;
    });
    const starter = listed.automations.filter((i) => i.automation.id.startsWith("starter:"));
    expect(starter.map((i) => i.automation.templateId).sort()).toEqual([
      "dependency-updates",
      "security-audit",
      "test-coverage",
    ]);
    expect(starter.every((i) => !i.automation.enabled && !i.states[0]?.enabled)).toBe(true);
    const file = listed.automations.find((i) => i.automation.source === "project_file");
    expect(file).toMatchObject({
      readOnly: true,
      automation: { id: `project:${h.projectId}:notes-reminder`, enabled: false },
    });
    expect(await upcoming()).toEqual([]);
  });

  it("starts a session on schedule; a second fire while it runs is skipped and the PM told", async () => {
    auditId = await create({
      name: "Audit",
      trigger: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" },
      action: {
        type: "start_session",
        prompt: "[approval] Audit {{project.name}}",
        provider: "fake",
      },
      workKey: "automation:security-audit",
      enabled: true,
    });
    expect(await upcoming()).toEqual([
      expect.objectContaining({ automationId: auditId, at: "2026-11-07T10:05:00.000Z" }),
    ]);

    await tick("2026-11-07T10:05:01Z");
    const [run] = await runs(auditId);
    expect(run).toMatchObject({
      status: "running",
      triggeredBy: "cron",
      workKey: "automation:security-audit",
    });
    const sessionId = run?.sessionId ?? "";
    const detail = await waitUntil(async () => {
      const d = await h.detail(sessionId);
      return d.session.status === "waiting" ? d : undefined;
    });
    expect(detail.session).toMatchObject({
      startedBy: { kind: "automation", id: auditId },
      automationRunId: run?.id,
      workKey: "automation:security-audit",
    });

    await tick("2026-11-07T10:10:01Z");
    const second = (await runs(auditId))[0];
    expect(second).toMatchObject({ status: "skipped", skipReason: "overlap", sessionId: null });
    const notice = await waitUntil(() =>
      h.server.services.orchestration.notices
        .list({ projectId: h.projectId })
        .find((n) => n.type === "automation.skipped"),
    );
    expect(notice).toMatchObject({
      target: "pm",
      data: { automationId: auditId, reason: "overlap", automationRunId: second?.id },
    });
    expect(h.server.services.orchestration.projectStatus(h.projectId).scheduled[0]).toMatchObject({
      automationId: auditId,
    });
  });

  it("lets the PM skip the next run, pause and resume", async () => {
    const listed = (await pmTool("list_scheduled_runs", {})) as { runs: ScheduledRun[] };
    expect(listed.runs[0]).toMatchObject({ automationId: auditId, at: "2026-11-07T10:15:00.000Z" });
    const skipped = (await pmTool("skip_next_run", { automationId: auditId })) as {
      skipped: ScheduledRun;
    };
    expect(skipped.skipped).toMatchObject({ at: "2026-11-07T10:15:00.000Z", skipped: true });
    expect((await upcoming()).map((r) => [r.at, r.skipped])).toEqual([
      ["2026-11-07T10:15:00.000Z", true],
      ["2026-11-07T10:20:00.000Z", false],
    ]);
    // Undo the skip over HTTP, then skip again.
    const undone = await h.api("POST", `/automations/${auditId}/unskip-next`, {
      projectId: h.projectId,
    });
    expect(undone.body).toMatchObject({ next: { at: "2026-11-07T10:15:00.000Z", skipped: false } });
    expect(
      (await h.api("POST", `/automations/${auditId}/unskip-next`, { projectId: h.projectId })).body,
    ).toEqual({ next: null });
    await h.api("POST", `/automations/${auditId}/skip-next`, { projectId: h.projectId });
    await tick("2026-11-07T10:15:01Z");
    expect((await runs(auditId))[0]).toMatchObject({
      status: "skipped",
      skipReason: "skipped_by_pm",
    });

    await pmTool("pause_automation", { automationId: auditId });
    expect(await upcoming()).toEqual([]);
    await pmTool("resume_automation", { automationId: auditId });
    expect((await upcoming())[0]).toMatchObject({ at: "2026-11-07T10:20:00.000Z", skipped: false });
    const tools = (await pmTool("list_automations", {})) as { automations: { id: string }[] };
    expect(tools.automations.map((a) => a.id)).toContain(auditId);
  });

  it("returns a conflict for a manual run, queues by policy and cancels queued runs", async () => {
    const conflict = RunAutomationResponse.parse(
      (await h.api("POST", `/automations/${auditId}/run`, { projectId: h.projectId })).body,
    );
    expect(conflict.status).toBe("conflict");

    const queueId = await create({
      name: "Audit (queued)",
      trigger: { type: "event", event: "pr.merged" },
      action: { type: "start_session", prompt: "Audit again", provider: "fake" },
      workKey: "automation:security-audit",
      guards: { overlapPolicy: "queue" },
      enabled: true,
    });
    const viaTool = (await pmTool("run_automation", {
      automationId: queueId,
      conflict: { resolution: "wait" },
    })) as { status: string; run: AutomationRun; sessionId: string };
    expect(viaTool).toMatchObject({ status: "queued", run: { status: "queued" } });
    expect((await h.detail(viaTool.sessionId)).session.status).toBe("queued");
    await pmTool("cancel_queued_run", { runId: viaTool.run.id });
    expect((await runs(queueId))[0]).toMatchObject({ status: "cancelled" });
    await waitUntil(async () =>
      (await h.detail(viaTool.sessionId)).session.status === "stopped" ? true : undefined,
    );

    // Stopping the audit session cancels its run.
    const running = (await runs(auditId)).find((r) => r.status === "running");
    expect(running?.sessionId).toBeTruthy();
    await h.api("POST", `/sessions/${running?.sessionId}/stop`);
    await waitUntil(async () =>
      (await runs(auditId)).find((r) => r.id === running?.id)?.status === "cancelled"
        ? true
        : undefined,
    );
  });

  it("completes a run when its session finishes, and messages the PM", async () => {
    const helloId = await create({
      name: "Hello",
      trigger: { type: "manual" },
      action: { type: "start_session", prompt: "hello", provider: "fake" },
    });
    const started = RunAutomationResponse.parse(
      (await h.api("POST", `/automations/${helloId}/run`, { projectId: h.projectId })).body,
    );
    expect(started.status).toBe("started");
    await waitUntil(async () =>
      (await runs(helloId))[0]?.status === "completed" ? true : undefined,
    );
    // The session's opening brief is recorded as the automation's (issue #53).
    const helloSession = (started.status === "started" && started.sessionId) || "";
    const root = (await h.detail(helloSession)).session.rootThreadId ?? "";
    const page = ThreadItemsPage.parse(
      (await h.api("GET", `/sessions/${helloSession}/threads/${root}/items?limit=50`)).body,
    );
    const brief = page.items.find((r) => r.item.kind === "user_message")?.item;
    expect(brief?.kind === "user_message" && brief.input.from).toBe("automation");

    const fileId = `project:${h.projectId}:notes-reminder`;
    const sent = RunAutomationResponse.parse(
      (await h.api("POST", `/automations/${fileId}/run`, { projectId: h.projectId })).body,
    );
    const pm = h.server.services.orchestration.roles.find("pm", h.projectId);
    expect(sent).toMatchObject({
      status: "started",
      run: { status: "completed", sessionId: pm?.id },
    });
  });

  it("reloads project files, keeping the enabled switch, and protects them from edits", async () => {
    const fileId = `project:${h.projectId}:notes-reminder`;
    await h.api("POST", `/automations/${fileId}/enable`, {});
    const path = join(h.repo, ".codeden/automations/notes-reminder.md");
    writeFileSync(path, NOTES_FILE.replace("Notes reminder", "Notes check"));
    await h.api("POST", "/automations/reload");
    const item = (await list()).automations.find((i) => i.automation.id === fileId);
    expect(item?.automation).toMatchObject({ name: "Notes check", enabled: true });
    const patch = await h.api("PATCH", `/automations/${fileId}`, { name: "x" });
    expect(patch.status).toBe(409);
    rmSync(path);
    await h.api("POST", "/automations/reload");
    expect((await list()).automations.some((i) => i.automation.id === fileId)).toBe(false);
  });

  it("enables the starter set and honours the project switch", async () => {
    const starter = await h.api("POST", `/projects/${h.projectId}/automations/starter`, {
      enable: true,
    });
    expect((starter.body as { automations: { enabled: boolean }[] }).automations).toHaveLength(3);
    expect((await upcoming()).length).toBeGreaterThanOrEqual(4);
    await h.api("PATCH", `/projects/${h.projectId}/automations/settings`, { enabled: false });
    expect(await upcoming()).toEqual([]);
    await h.api("PATCH", `/projects/${h.projectId}/automations/settings`, { enabled: true });
    expect((await upcoming()).length).toBeGreaterThanOrEqual(4);
  });

  it("in Manual mode, only runs someone starts happen", async () => {
    expect((await upcoming()).length).toBeGreaterThan(0);
    const manual = await h.api("PUT", `/projects/${h.projectId}/autonomy`, { mode: "manual" });
    expect(manual.status).toBe(200);
    await waitUntil(async () => ((await upcoming()).length === 0 ? true : undefined));
    expect((await list()).automations.every((i) => i.states.every((st) => !st.nextRunAt))).toBe(
      true,
    );
    // An event automation does not fire on its own...
    const onFinish = await create({
      name: "After sessions",
      enabled: true,
      trigger: { type: "event", event: "session.failed" },
      action: { type: "message_pm", message: "A session failed" },
    });
    const sessionId = h.server.services.sessionRepo.list({ projectId: h.projectId })[0]?.id ?? "";
    expect(sessionId).not.toBe("");
    const failedNotice = (id: string) =>
      h.server.services.store.append([
        {
          type: "notice.created",
          sessionId: null,
          payload: {
            notice: {
              id,
              type: "session.failed",
              projectId: h.projectId,
              target: "pm",
              sessionId,
              title: "x",
              data: {},
              createdAt: new Date().toISOString(),
              deliveredAt: null,
            },
          },
        } as never,
      ]);
    failedNotice("n-manual-1");
    await new Promise((r) => setTimeout(r, 200));
    expect(await runs(onFinish)).toEqual([]);
    // ...but a manual run still does.
    const ran = await h.api("POST", `/automations/${onFinish}/run`, { projectId: h.projectId });
    expect((ran.body as { status: string }).status).toBe("started");
    const back = await h.api("PUT", `/projects/${h.projectId}/autonomy`, { mode: "assisted" });
    expect(back.status).toBe(200);
    await waitUntil(async () => ((await upcoming()).length > 0 ? true : undefined));
    // Back in Assisted mode the same event fires on its own.
    failedNotice("n-manual-2");
    await waitUntil(async () => ((await runs(onFinish)).length === 2 ? true : undefined));
  });

  it("sets and clears a project override of an all-projects automation", async () => {
    const created = await h.api("POST", "/automations", {
      name: "Everywhere",
      target: { type: "all_projects" },
      trigger: { type: "manual" },
      action: { type: "message_pm", message: "hi" },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { automation: { id: string } }).automation.id;
    const state = (body: unknown) =>
      (body as { states: { projectId: string; enabledOverride: boolean | null }[] }).states.find(
        (st) => st.projectId === h.projectId,
      );
    const on = await h.api("POST", `/automations/${id}/enable`, { projectId: h.projectId });
    expect(state(on.body)?.enabledOverride).toBe(true);
    const cleared = await h.api("POST", `/automations/${id}/clear-override`, {
      projectId: h.projectId,
    });
    expect(cleared.status).toBe(200);
    expect(state(cleared.body)?.enabledOverride).toBeNull();
    const projectOnly = (await h.api("GET", `/automations?projectId=${h.projectId}`)).body as {
      automations: { automation: { id: string; target: { type: string } } }[];
    };
    const local = projectOnly.automations.find((a) => a.automation.target.type === "project");
    const refused = await h.api("POST", `/automations/${local?.automation.id}/clear-override`, {
      projectId: h.projectId,
    });
    expect(refused.status).toBe(409);
  });
});
