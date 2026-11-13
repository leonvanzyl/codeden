import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxItem } from "@codeden/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, TOKEN, waitUntil } from "./support/harness";

let h: Harness;
let sessionId: string;
let token: string;

beforeAll(async () => {
  h = await startHarness({ askUserWaitMs: 1_500 });
  sessionId = await h.startFakeSession();
  token = h.server.services.mcpTokens.mint({
    role: "agent",
    sessionId,
    projectId: h.projectId,
  });
}, 60_000);

afterAll(async () => {
  await h?.close();
});

/** An MCP client talking to the runner's local proxy, as agents do (§4.4). */
async function connect(bearer: string): Promise<Client> {
  const url = h.server.runner?.mcpProxyUrl;
  if (!url) throw new Error("no proxy url");
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

const initialize = (bearer?: string) =>
  fetch(`${h.server.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  });

describe("CodeDen MCP endpoint", () => {
  it("rejects requests without a valid session token, including the install token", async () => {
    expect((await initialize()).status).toBe(401);
    expect((await initialize(TOKEN)).status).toBe(401);
    expect((await initialize("cdm_not-a-real-token")).status).toBe(401);
    expect((await initialize(token)).status).toBe(200);
  });

  it("lists the tools of the caller's role, core tools marked always-loaded", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "report_progress",
      "ask_user",
      "share_to_chat",
      "suggest_followups",
      "finish",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_mouse",
      "browser_dialog",
      "browser_screenshot",
      "browser_logs",
      "browser_wait",
      "browser_evaluate",
      "browser_open_dev_server",
    ]);
    expect(tools[0]?._meta).toEqual({ "anthropic/alwaysLoad": true });
    // A flat object schema, so every provider accepts it (no top-level anyOf/oneOf).
    const mouse = tools.find((t) => t.name === "browser_mouse")?.inputSchema;
    expect(mouse).toMatchObject({ type: "object", required: ["action", "x", "y"] });
    expect(mouse).not.toHaveProperty("anyOf");
    expect(mouse).not.toHaveProperty("oneOf");
    await client.close();

    const pmToken = h.server.services.mcpTokens.mint({
      role: "pm",
      sessionId: "pm-session",
      projectId: h.projectId,
    });
    const pm = await connect(pmToken);
    const pmTools = (await pm.listTools()).tools;
    expect(pmTools.map((t) => t.name)).toEqual([
      "ask_user",
      "share_to_chat",
      "get_project_status",
      "list_sessions",
      "get_session",
      "start_session",
      "message_session",
      "stop_session",
      "answer_question",
      "list_scheduled_runs",
      "skip_next_run",
      "pause_automation",
      "resume_automation",
      "cancel_queued_run",
      "message_orchestrator",
      "read_project_notes",
      "update_project_notes",
      "list_automations",
      "run_automation",
      "create_automation",
      "update_automation",
      "schedule_wakeup",
      "list_wakeups",
      "cancel_wakeup",
    ]);
    await pm.close();
  });

  it("records progress, follow-ups, shared images and the result", async () => {
    const client = await connect(token);
    await client.callTool({ name: "report_progress", arguments: { text: "Writing tests" } });
    await client.callTool({
      name: "suggest_followups",
      arguments: { suggestions: ["Add docs", "Run the linter"] },
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const shared = await client.callTool({
      name: "share_to_chat",
      arguments: { imageBase64: png.toString("base64"), mediaType: "image/png", caption: "Dot" },
    });
    expect(text(shared)).toMatch(/Shared image\.png/);
    await client.callTool({
      name: "finish",
      arguments: { outcome: "success", summary: "All done" },
    });
    const bad = await client.callTool({
      name: "suggest_followups",
      arguments: { suggestions: [] },
    });
    expect(bad.isError).toBe(true);
    await client.close();

    const d = await h.detail(sessionId);
    expect(d.session.progress?.text).toBe("Writing tests");
    expect(d.session.result).toMatchObject({ outcome: "success", summary: "All done" });
    expect(d.followups?.source).toBe("agent");
    expect(d.followups?.suggestions.map((s) => s.prompt)).toEqual(["Add docs", "Run the linter"]);
    const artifacts = h.server.services.artifacts.list({ sessionId });
    expect(artifacts[0]).toMatchObject({ kind: "image", mediaType: "image/png" });
  });

  it("never stores a secrets file as an artifact (attach_evidence could publish it)", async () => {
    const cwd = h.server.services.sessionRepo.get(sessionId).cwd;
    writeFileSync(join(cwd, ".env"), "SECRET=hunter2\n");
    writeFileSync(join(cwd, "notes.txt"), "notes\n");
    const client = await connect(token);
    const before = h.server.services.artifacts.list({ sessionId }).length;
    for (const args of [
      { path: ".env" },
      { path: ".env", name: "config.txt" },
      { path: "notes.txt", name: "id_rsa" },
    ]) {
      const result = await client.callTool({ name: "share_to_chat", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toMatch(/secrets file/);
    }
    expect(h.server.services.artifacts.list({ sessionId })).toHaveLength(before);
    expect(
      text(await client.callTool({ name: "share_to_chat", arguments: { path: "notes.txt" } })),
    ).toMatch(/Shared notes\.txt/);
    await client.close();
  });

  it("checks browser_mouse fields per action, then sends valid calls to the session browser", async () => {
    const client = await connect(token);
    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: "browser_mouse", arguments: args });
    const refused = [
      { action: "drag", x: 1, y: 1, toX: 5 }, // no toY
      { action: "scroll", x: 1, y: 1 }, // no delta
      { action: "hover", x: 1, y: 1, clickCount: 2 }, // a click field
      { action: "click", x: -1, y: 1 },
    ];
    for (const args of refused) {
      const result = await call(args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).not.toMatch(/No browser for session/);
    }
    // A valid call reaches the runner, which has no browser open for this session.
    const valid = await call({ action: "click", x: 10, y: 20 });
    expect(valid.isError).toBe(true);
    expect(text(valid)).toMatch(/No browser for session/);
    // Typing without a ref is capped; with a ref it is not.
    const long = await client.callTool({
      name: "browser_type",
      arguments: { text: "x".repeat(2_001) },
    });
    expect(long.isError).toBe(true);
    expect(text(long)).toMatch(/at most 2000 characters/);
    await client.close();
  });

  it("asks the user and returns the answer given within the wait", async () => {
    const client = await connect(token);
    const call = client.callTool({
      name: "ask_user",
      arguments: { question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] },
    });
    const question = await waitUntil(async () => {
      const items = ((await h.api("GET", `/inbox?sessionId=${sessionId}`)).body as unknown[]).map(
        (i) => InboxItem.parse(i),
      );
      return items.find((i) => i.kind === "question" && i.status === "open");
    });
    const res = await h.api("POST", `/sessions/${sessionId}/respond`, {
      requestId: question.requestId,
      response: { kind: "answer", answers: { q1: ["Blue"] } },
    });
    expect(res.status).toBe(200);
    expect(text(await call)).toContain("A: Blue");
    await client.close();
  });

  it("returns pending after the wait and delivers a late answer as a message", async () => {
    const client = await connect(token);
    const result = await client.callTool({ name: "ask_user", arguments: { question: "Ship it?" } });
    expect(text(result)).toMatch(/^pending/);
    await client.close();
    const question = await waitUntil(async () => {
      const items = ((await h.api("GET", `/inbox?sessionId=${sessionId}`)).body as unknown[]).map(
        (i) => InboxItem.parse(i),
      );
      return items.find((i) => i.kind === "question" && i.status === "open");
    });
    await h.api("POST", `/sessions/${sessionId}/respond`, {
      requestId: question.requestId,
      response: { kind: "answer", answers: { q1: ["Yes"] } },
    });
    // The Fake provider echoes the message it received.
    const snapshot = await waitUntil(async () => {
      const snap = (await h.api("GET", `/sessions/${sessionId}/snapshot`)).body as {
        items: Array<{ item: { kind: string; text?: string } }>;
      };
      return snap.items.some(
        (i) =>
          i.item.kind === "assistant_message" &&
          i.item.text?.includes("Answer to your earlier question"),
      )
        ? snap
        : undefined;
    });
    expect(snapshot).toBeTruthy();
  });

  it("keeps a session's token when a turn fails, so its next turn still has the tools", async () => {
    const failing = await h.startFakeSession();
    const live = h.server.services.mcpTokens.mint({
      role: "agent",
      sessionId: failing,
      projectId: h.projectId,
    });
    await h.api("POST", `/sessions/${failing}/messages`, { input: { text: "[fail] try it" } });
    await waitUntil(async () =>
      (await h.detail(failing)).session.status === "failed" ? true : undefined,
    );
    // Give the lifecycle (which revokes tokens of ended sessions) a chance to run.
    await new Promise((r) => setTimeout(r, 200));
    expect((await initialize(live)).status).toBe(200);

    // The provider process lives on, so the next turn reaches it with the same token.
    await h.api("POST", `/sessions/${failing}/messages`, { input: { text: "Try again" } });
    await waitUntil(async () =>
      (await h.detail(failing)).session.status === "idle" ? true : undefined,
    );
    const client = await connect(live);
    const res = await client.callTool({
      name: "report_progress",
      arguments: { text: "Back on track" },
    });
    expect(res.isError).toBeFalsy();
    await client.close();
    expect((await h.detail(failing)).session.progress?.text).toBe("Back on track");
  });

  it("revokes the session's tokens when it stops", async () => {
    await h.api("POST", `/sessions/${sessionId}/stop`);
    await waitUntil(async () => ((await initialize(token)).status === 401 ? true : undefined));
  });
});
