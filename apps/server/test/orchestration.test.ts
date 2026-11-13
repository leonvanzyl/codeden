import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConflictRecord,
  type ItemRecord,
  NOTICE_BATCH_CODE,
  NoticeBatchData,
  type Role,
  RoleMessageResponse,
  RoleSessionResponse,
  SessionDetail,
  Snapshot,
  StartSessionResponse,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("orchestration (§8): role sessions, digest, tools, notices, conflicts", () => {
  let h: Harness;
  let pmId: string;

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

  const items = async (sessionId: string): Promise<ItemRecord[]> => {
    const d = await h.detail(sessionId);
    if (!d.session.rootThreadId) return [];
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${d.session.rootThreadId}/items?limit=500`,
    );
    return ThreadItemsPage.parse(res.body).items;
  };
  const statusIs = (id: string, status: string) =>
    waitUntil(async () => {
      const d = await h.detail(id);
      return d.session.status === status ? d : undefined;
    });
  const startAgent = async (body: Record<string, unknown>) => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      ...body,
    });
    return StartSessionResponse.parse(res.body);
  };

  beforeAll(async () => {
    h = await startHarness({
      orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 }, askTimeoutMs: 15_000 },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("filters tools by role", async () => {
    const names = (role: Role) => h.server.services.tools.list(role).map((t) => t.name);
    expect(names("orchestrator")).toEqual(
      expect.arrayContaining([
        "get_overview",
        "list_projects",
        "create_project",
        "update_project",
        "message_pm",
        "ask_pm",
        "list_inbox",
      ]),
    );
    expect(names("orchestrator")).not.toContain("start_session");
    expect(names("pm")).toEqual(
      expect.arrayContaining(["start_session", "get_project_status", "ask_user"]),
    );
    expect(names("pm")).not.toContain("ask_pm");
    expect(names("agent")).not.toContain("start_session");
    expect(names("agent")).not.toContain("get_overview");
    const denied = await call(
      "agent",
      "start_session",
      { prompt: "x", purpose: "x" },
      "a",
      h.projectId,
    );
    expect(denied).toMatchObject({ isError: true, text: "Unknown tool: start_session" });
    const awareness = h.server.services.tools
      .list("pm")
      .filter((t) =>
        [
          "get_project_status",
          "list_sessions",
          "list_scheduled_runs",
          "skip_next_run",
          "stop_session",
        ].includes(t.name),
      );
    expect(awareness.every((t) => t._meta?.["anthropic/alwaysLoad"] === true)).toBe(true);
  });

  it("creates the PM lazily in the read-only project root and prepends the digest", async () => {
    const before = RoleSessionResponse.parse(
      (await h.api("GET", `/orchestration/projects/${h.projectId}/pm`)).body,
    );
    expect(before.session).toBeNull();
    const sent = RoleMessageResponse.parse(
      (
        await h.api("POST", `/orchestration/projects/${h.projectId}/pm/messages`, {
          input: { text: "hello pm" },
        })
      ).body,
    );
    pmId = sent.sessionId;
    // A lazily created PM is idle once it has started, before its queued first message
    // is flushed, so wait for the message's turn to finish rather than for the first idle.
    await waitUntil(async () => {
      const d = await h.detail(pmId);
      if (d.session.status !== "idle" || !d.session.rootThreadId) return undefined;
      const hasMessage = (await items(pmId)).some((r) => r.item.kind === "user_message");
      return hasMessage && (await h.detail(pmId)).session.status === "idle" ? true : undefined;
    });
    const pm = (await h.detail(pmId)).session;
    expect(pm).toMatchObject({
      role: "pm",
      projectId: h.projectId,
      worktreePath: null,
      cwd: h.repo,
    });
    const user = (await items(pmId)).find((r) => r.item.kind === "user_message");
    const text = user?.item.kind === "user_message" ? user.item.input.text : "";
    expect(text).toContain("<codeden_status project=");
    expect(text).toContain("Running: none");
    expect(text.endsWith("hello pm")).toBe(true);
    const snapshot = Snapshot.parse((await h.api("GET", "/snapshot")).body);
    expect(snapshot.roleSessions?.pms[h.projectId]).toBe(pmId);
    // Same session afterwards.
    const again = RoleSessionResponse.parse(
      (await h.api("POST", `/orchestration/projects/${h.projectId}/pm`)).body,
    );
    expect(again.session?.id).toBe(pmId);
  });

  it("returns conflicts from start_session and honours the PM's resolution", async () => {
    const audit = await startAgent({
      workKey: "automation:security-audit",
      purpose: "Security audit",
      title: "Security audit",
      startedBy: { kind: "automation", id: "audit" },
      input: { text: "audit [approval]" },
    });
    if (audit.status !== "started") throw new Error("expected started");
    await statusIs(audit.sessionId, "waiting");

    const args = {
      prompt: "Run a security audit",
      purpose: "Security audit",
      workKey: "automation:security-audit",
    };
    const conflict = await call("pm", "start_session", args, pmId, h.projectId);
    const body = JSON.parse(conflict.text);
    expect(body.status).toBe("conflict");
    expect(body.existing[0]).toMatchObject({
      sessionId: audit.sessionId,
      workKey: "automation:security-audit",
    });

    const skipped = await call(
      "pm",
      "start_session",
      { ...args, conflict: { resolution: "skip" } },
      pmId,
      h.projectId,
    );
    expect(JSON.parse(skipped.text)).toMatchObject({ status: "skipped" });

    const status = await call("pm", "get_project_status", {}, pmId, h.projectId);
    expect(status.text).toContain("automation:security-audit · waiting");
    const listed = JSON.parse(
      (
        await call(
          "pm",
          "list_sessions",
          { workKey: "automation:security-audit" },
          pmId,
          h.projectId,
        )
      ).text,
    );
    expect(listed.sessions.map((s: { id: string }) => s.id)).toEqual([audit.sessionId]);
  });

  it("persists user conflicts as inbox items resolvable with wait, skip, join or force", async () => {
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const image = {
      type: "image",
      mediaType: "image/png",
      name: "image.png",
      source: { type: "base64", data: PNG_B64 },
    };
    const dup = {
      workKey: "automation:security-audit",
      purpose: "Audit again",
      input: { text: "audit", attachments: [image] },
    };
    const first = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      ...dup,
      input: { text: "audit" },
    });
    expect(first.status).toBe(409);
    const firstId = (first.body as { conflictId: string }).conflictId;
    // Sent again (with an image now): the new conflict replaces the first one (#169).
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      ...dup,
      replacesConflict: firstId,
    });
    expect(res.status).toBe(409);
    const conflictId = (res.body as { conflictId: string }).conflictId;
    expect(conflictId).toBeTruthy();

    const open = ((await h.api("GET", "/conflicts")).body as unknown[]).map((c) =>
      ConflictRecord.parse(c),
    );
    expect(open.map((c) => c.id)).toContain(conflictId);
    expect(open.map((c) => c.id)).not.toContain(firstId);
    expect(
      (await h.api("POST", `/conflicts/${firstId}/resolve`, { resolution: "wait" })).status,
    ).toBe(409);
    const inbox = (await h.api("GET", "/inbox")).body as { id: string; kind: string }[];
    expect(inbox.find((i) => i.id === conflictId)?.kind).toBe("conflict");

    const resolved = await h.api("POST", `/conflicts/${conflictId}/resolve`, {
      resolution: "wait",
    });
    expect(resolved.status).toBe(200);
    const out = resolved.body as { conflict: ConflictRecord; result: StartSessionResponse };
    expect(out.result.status).toBe("queued");
    expect(out.conflict).toMatchObject({ status: "resolved", resolution: { resolution: "wait" } });
    // The pasted image was saved as an artifact: neither the record nor the pending start
    // carries its bytes (#169).
    expect(JSON.stringify(out.conflict)).not.toContain(PNG_B64);
    const queuedId = out.result.status === "queued" ? out.result.sessionId : "";
    const pending = h.server.services.sessionRepo.find(queuedId)?.startMeta?.pending;
    expect(pending?.input?.attachments[0]).toMatchObject({ source: { type: "artifact" } });
    expect(
      (await h.api("POST", `/conflicts/${conflictId}/resolve`, { resolution: "skip" })).status,
    ).toBe(409);
    if (out.result.status === "queued")
      await h.api("POST", `/sessions/${out.result.sessionId}/stop`);

    const notices = (await h.api("GET", `/orchestration/notices?projectId=${h.projectId}`))
      .body as { type: string }[];
    expect(notices.map((n) => n.type)).toContain("conflict");
  });

  it("wakes the PM with typed notices when its agent finishes", async () => {
    const started = JSON.parse(
      (
        await call(
          "pm",
          "start_session",
          { prompt: "Fix the typo", purpose: "Fix typo", workKey: "issue:3" },
          pmId,
          h.projectId,
        )
      ).text,
    );
    expect(started.status).toBe("started");
    const batch = await waitUntil(async () => {
      for (const r of await items(pmId)) {
        if (r.item.kind !== "notice" || r.item.code !== NOTICE_BATCH_CODE) continue;
        const data = NoticeBatchData.parse(r.item.data);
        if (
          data.notices.some(
            (n) => n.type === "session.finished" && n.sessionId === started.sessionId,
          )
        )
          return data;
      }
      return undefined;
    });
    expect(batch.notices.length).toBeGreaterThanOrEqual(1);
    await statusIs(pmId, "idle");
    const undelivered = h.server.services.orchestration.notices.undelivered("pm", h.projectId);
    expect(undelivered.find((n) => n.sessionId === started.sessionId)).toBeUndefined();
  });

  it("answers ask_pm from the PM's turn, including the running audit from its digest", async () => {
    const res = await call(
      "orchestrator",
      "ask_pm",
      { projectId: h.projectId, question: "Run a security audit on this project" },
      "orch-test",
      null,
    );
    expect(res.isError).toBe(false);
    expect(res.text).toContain("answered:");
    expect(res.text).toContain("Question from the orchestrator (ask ");
    expect(res.text).toContain("automation:security-audit · waiting");
    await statusIs(pmId, "idle");
  });

  it("keeps informational PM messages out of the orchestrator's way and wakes it otherwise", async () => {
    const info = await call(
      "pm",
      "message_orchestrator",
      { text: "Audit still running", informational: true },
      pmId,
      h.projectId,
    );
    expect(info.text).toContain("next status digest");
    expect(h.server.services.orchestration.overview().pmMessages.map((m) => m.text)).toContain(
      "Audit still running",
    );
    expect(h.server.services.orchestration.roles.find("orchestrator", null)).toBeUndefined();

    await call(
      "pm",
      "message_orchestrator",
      { text: "Need a decision on the audit" },
      pmId,
      h.projectId,
    );
    const orchestrator = await waitUntil(() =>
      h.server.services.orchestration.roles.find("orchestrator", null),
    );
    await waitUntil(async () => {
      const user = (await items(orchestrator.id)).find((r) => r.item.kind === "user_message");
      return user ? true : undefined;
    });
    const user = (await items(orchestrator.id)).find((r) => r.item.kind === "user_message");
    const text = user?.item.kind === "user_message" ? user.item.input.text : "";
    expect(text).toContain('<codeden_status scope="all projects"');
    expect(text).toContain("Need a decision on the audit");
    expect(text).toContain("Audit still running");
  });

  it("stores project notes for the PM and changes model/effort on the next turn", async () => {
    await call(
      "pm",
      "update_project_notes",
      { content: "# Notes\nPrefer small PRs.", mode: "replace" },
      pmId,
      h.projectId,
    );
    await call("pm", "update_project_notes", { content: "Audit weekly." }, pmId, h.projectId);
    const read = await call("pm", "read_project_notes", {}, pmId, h.projectId);
    expect(read.text).toBe("# Notes\nPrefer small PRs.\n\nAudit weekly.\n");
    expect(readFileSync(join(h.repo, ".codeden", "notes.md"), "utf8")).toBe(read.text);

    const id = await h.startFakeSession("first");
    const patched = await h.api("PATCH", `/sessions/${id}`, { model: "fake-2", effort: "high" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ model: "fake-2", effort: "high" });
    const meta = () =>
      h.server.services.sessionRepo.find(id)?.startMeta as { pendingConfig?: unknown };
    expect(meta().pendingConfig).toEqual({ model: "fake-2", effort: "high" });
    await h.api("POST", `/sessions/${id}/messages`, { input: { text: "second" } });
    await waitUntil(async () => (meta().pendingConfig === undefined ? true : undefined));
    expect(SessionDetail.parse((await h.api("GET", `/sessions/${id}`)).body).session.model).toBe(
      "fake-2",
    );
    expect((await h.api("PATCH", `/sessions/${id}`, {})).status).toBe(400);
  });
});
