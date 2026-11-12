import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEnvelope, SessionSnapshot } from "@codeden/contracts";
import { OpenCodeAdapter } from "@codeden/providers";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import type { Exec } from "../src/services/exec";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/** A stand-in for `opencode` (shared with the provider tests). */
const fakeOpenCode = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "providers",
    "test",
    "fixtures",
    "fake-opencode",
    "opencode.mjs",
  ),
};

const TOKEN = "e".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

/** No CLI is installed (setup checks never reach the machine's real tools). */
const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

let home: string;
let runner: RunningRunner;
let server: RunningServer;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-opencode-e2e-"));
  process.env.FAKE_OPENCODE_STATE = join(home, "opencode-state.json");
  runner = await startRunner({
    home,
    adapters: [new OpenCodeAdapter({ executable: fakeOpenCode, noGuardPlugin: true })],
  });
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec: nothingInstalled,
    realtimeFlushMs: 10,
  });
});

afterAll(async () => {
  await server?.close();
  await runner?.close();
  delete process.env.FAKE_OPENCODE_STATE;
  await removeTree(home);
});

const typesFor = (sessionId: string) =>
  server.store.listAfter(0, 10_000, [sessionId]).map((e) => EventEnvelope.parse(e));

const rootDone = (sessionId: string, count: number) => () =>
  typesFor(sessionId).filter(
    (e) =>
      e.type === "agent.turn.completed" &&
      (e.payload as { threadId: string }).threadId === `${sessionId}:thread-root`,
  ).length >= count || undefined;

describe("server <-> runner <-> OpenCode", () => {
  it("lists OpenCode with its models and honest capabilities", async () => {
    await waitUntil(() =>
      (server.runner?.status.providers.find((p) => p.id === "opencode")?.models.length ?? 0) > 1
        ? true
        : undefined,
    );
    const opencode = server.runner?.status.providers.find((p) => p.id === "opencode");
    expect(opencode).toMatchObject({
      displayName: "OpenCode",
      capabilities: { steer: true, approvals: true, liveAutonomy: true, readOnly: true },
    });
    expect(opencode?.models[0]).toMatchObject({ id: "anthropic/claude-opus-5-5", isDefault: true });
  });

  it("runs an OpenCode session through the runner, approvals included, and stores it", async () => {
    server.store.append([
      {
        type: "session.created",
        sessionId: "oc1",
        payload: { session: { ...sampleSession, id: "oc1", provider: "opencode" } },
      },
    ]);
    const result = await server.runner?.request({
      name: "session.start",
      sessionId: "oc1",
      providerId: "opencode",
      options: {
        sessionId: "oc1",
        role: "agent",
        cwd: home,
        model: "anthropic/claude-opus-5-5",
        autonomy: "supervised",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      },
      input: { text: "edit the file", attachments: [] },
    });
    expect(result?.resumeToken).toMatch(/^ses_/);

    // Supervised: the edit waits for an approval, answered through the runner.
    const approval = await waitUntil(() =>
      typesFor("oc1")
        .map((e) => e.payload as { item?: { kind: string; requestId?: string; status?: string } })
        .find((p) => p.item?.kind === "approval_request" && p.item.status === "in_progress"),
    );
    await server.runner?.request({
      name: "session.respond",
      sessionId: "oc1",
      requestId: approval.item?.requestId ?? "",
      response: { kind: "approval", decision: "allow_once" },
    });
    await waitUntil(rootDone("oc1", 1));

    const res = await fetch(`${server.url}/api/sessions/oc1/snapshot`, { headers: auth });
    const snapshot = SessionSnapshot.parse(await res.json());
    expect(snapshot.session.resumeToken).toBe(result?.resumeToken);
    const kinds = snapshot.items.map((i) => i.item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "user_message",
        "approval_request",
        "tool_call",
        "assistant_message",
      ]),
    );
    const edit = snapshot.items.find((i) => i.item.kind === "tool_call");
    expect(edit?.item).toMatchObject({ toolKind: "file_edit", status: "completed" });

    // A second turn through `session.send`, then the usage the turns reported.
    await server.runner?.request({
      name: "session.send",
      sessionId: "oc1",
      input: { text: "hello", attachments: [] },
    });
    await waitUntil(rootDone("oc1", 2));
    const usage = typesFor("oc1").filter((e) => e.type === "agent.usage.updated");
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.at(-1)?.payload).toMatchObject({ usage: { costUsd: 0.0025, inputTokens: 100 } });
  });
});
