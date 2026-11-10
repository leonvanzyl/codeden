import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../../src/opencode/adapter";
import { validateEventStream } from "../../src/replay/validate";
import { Collector, LIVE, LIVE_TIMEOUT, requestRecorder, sessionOptions, tempDir } from "./helpers";
import { checkInterrupt, checkSteer } from "./shared";

/**
 * Live smoke test against the installed `opencode` (2.2+), skipped unless CODEDEN_LIVE=1:
 *   CODEDEN_LIVE=1 pnpm --filter @codeden/providers exec vitest run test/live/opencode.live.test.ts
 * Uses OpenCode's configured default model unless CODEDEN_LIVE_OPENCODE_MODEL names one
 * (`<provider>/<model>`, e.g. `anthropic/claude-haiku-5-5`). A few small turns: small cost.
 */
const MODEL = process.env.CODEDEN_LIVE_OPENCODE_MODEL;
const base = { effort: "low" as const, ...(MODEL ? { model: MODEL } : {}) };

describe.skipIf(!LIVE)("OpenCode live smoke", () => {
  const adapter = new OpenCodeAdapter();
  const cwd = tempDir();
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it("detects the installed CLI and at least one provider", async () => {
    const status = await adapter.detect();
    expect(status).toMatchObject({ installed: true, loggedIn: true, supported: true });
  });

  it("lists its models without a session or a model call", async () => {
    const fresh = new OpenCodeAdapter();
    await fresh.refreshModels();
    const models = fresh.models();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.includes("/"))).toBe(true);
    expect(models.filter((m) => m.isDefault).length).toBeLessThanOrEqual(1);
  });

  it("runs a real turn that edits a file, then resumes it", { timeout: LIVE_TIMEOUT }, async () => {
    const session = await adapter.openSession(sessionOptions(cwd, base));
    cleanups.push(() => session.close());
    const c = new Collector(session);
    const r = await c.turn("Create hello.txt containing hi, then tell me you're done.");
    expect(r.end.type).toBe("turn.completed");
    expect(readFileSync(path.join(cwd, "hello.txt"), "utf8").trim()).toBe("hi");
    expect(
      r.events.some(
        (e) =>
          e.type === "item.completed" &&
          e.item.kind === "tool_call" &&
          (e.item.toolKind === "file_edit" || e.item.toolKind === "command"),
      ),
    ).toBe(true);
    expect(r.events.some((e) => e.type === "usage.updated" && e.usage.inputTokens)).toBe(true);
    expect(validateEventStream(c.all)).toEqual([]);
    const token = session.resumeToken();
    await session.close();

    const resumed = await adapter.openSession(sessionOptions(cwd, { ...base, resumeToken: token }));
    cleanups.push(() => resumed.close());
    const again = await new Collector(resumed).turn(
      "What file did you create? Answer in one word.",
    );
    expect(again.end.type).toBe("turn.completed");
    expect(again.text.toLowerCase()).toContain("hello");
    expect(resumed.resumeToken()).toBe(token);
  });

  it("round-trips an approval in supervised mode", { timeout: LIVE_TIMEOUT }, async () => {
    const session = await adapter.openSession(
      sessionOptions(tempDir(), { ...base, autonomy: "supervised" }),
    );
    cleanups.push(() => session.close());
    const r = await new Collector(session).turn("Create note.txt containing ok.");
    expect(r.approvals.length).toBeGreaterThan(0);
    expect(r.end.type).toBe("turn.completed");
  });

  it("reaches CodeDen's MCP server with the bearer header", { timeout: LIVE_TIMEOUT }, async () => {
    const recorder = await requestRecorder();
    cleanups.push(() => recorder.close());
    const session = await adapter.openSession(
      sessionOptions(tempDir(), {
        ...base,
        mcpServers: [
          {
            transport: "http",
            name: "codeden",
            url: recorder.url,
            headers: { Authorization: "Bearer live-test-token" },
            trusted: true,
          },
        ],
      }),
    );
    cleanups.push(() => session.close());
    await new Collector(session).turn("Reply with exactly: ok");
    expect(
      recorder.requests.some((r) => r.headers.authorization === "Bearer live-test-token"),
    ).toBe(true);
  });

  it("interrupts a running turn", { timeout: LIVE_TIMEOUT }, () => checkInterrupt(adapter, base));

  it("steers a running turn", { timeout: LIVE_TIMEOUT }, () => checkSteer(adapter, base));
});
