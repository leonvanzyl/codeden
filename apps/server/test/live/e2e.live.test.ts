/**
 * Live end-to-end tests (real agent turns, small cost). Run with
 *   pnpm --filter @codeden/server test:live
 * A temp git repo becomes a project; a real Claude or Codex session runs in a new worktree
 * with autonomy `auto`, creates hello.txt, calls CodeDen's MCP tools through the runner
 * proxy (report_progress, suggest_followups), and the checkpoint diff shows the file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DiffResult,
  type ItemRecord,
  StartSessionResponse,
  type TranscriptMessage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, TOKEN, waitUntil } from "../support/harness";
import { TestWsClient } from "../support/ws-client";

const LIVE = process.env.CODEDEN_LIVE === "1";

const PROMPT = [
  "Create a file named hello.txt in the current directory containing exactly: hi",
  "Before you start, call the codeden report_progress tool with a short status.",
  "When the file exists, call the codeden suggest_followups tool with two suggestions, then reply 'done'.",
].join("\n");

const MODELS: Record<string, string | undefined> = {
  claude: process.env.CODEDEN_LIVE_CLAUDE_MODEL ?? "haiku",
  codex: process.env.CODEDEN_LIVE_CODEX_MODEL,
  opencode: process.env.CODEDEN_LIVE_OPENCODE_MODEL,
};

describe.skipIf(!LIVE)("live end-to-end", () => {
  let h: Harness;
  let ws: TestWsClient;

  beforeAll(async () => {
    h = await startHarness({ builtinProviders: true, log: (m) => console.log(`[server] ${m}`) });
    ws = await TestWsClient.connect(h.server.url, TOKEN);
    ws.send({ type: "subscribe", fromSeq: h.server.store.headSeq(), agentEvents: false });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await h?.close();
  });

  for (const provider of ["claude", "codex", "opencode"] as const) {
    it(`${provider}: worktree session creates hello.txt, uses MCP tools, diff shows it`, async () => {
      const res = await h.api("POST", "/sessions", {
        projectId: h.projectId,
        provider,
        model: MODELS[provider],
        effort: "low",
        autonomy: "auto",
        purpose: `Live ${provider} hello`,
        workspace: { mode: "worktree" },
        input: { text: PROMPT },
      });
      const started = StartSessionResponse.parse(res.body);
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const id = started.sessionId;
      ws.send({ type: "watch_session", sessionId: id, fromSeq: 0 });

      const t0 = Date.now();
      const done = await waitUntil(async () => {
        const d = await h.detail(id);
        if (d.session.status === "failed") throw new Error(`session failed: ${JSON.stringify(d)}`);
        const turnDone = d.session.status === "idle" && d.session.rootThreadId;
        return turnDone ? d : undefined;
      }, 300_000);
      console.log(`[live] ${provider} turn finished in ${Math.round((Date.now() - t0) / 1000)}s`);

      // Items streamed over the UI WebSocket.
      const items = new Map<string, ItemRecord>();
      for (const m of ws.messages) {
        if (m.type === "transcript" && m.sessionId === id) {
          for (const r of (m as TranscriptMessage).items) items.set(r.item.id, r);
        }
      }
      const kinds = [...items.values()].map((r) => r.item.kind);
      console.log(`[live] ${provider} streamed item kinds: ${[...new Set(kinds)].join(", ")}`);
      for (const r of items.values()) {
        const it = r.item;
        const detail =
          it.kind === "tool_call"
            ? `${it.toolName} ${JSON.stringify(it.input ?? {}).slice(0, 120)} -> ${(it.output?.text ?? it.error?.message ?? "").slice(0, 160)}`
            : it.kind === "assistant_message"
              ? it.text.slice(0, 200)
              : "";
        console.log(`[live] ${provider}   ${it.kind} ${it.status} ${detail}`);
      }
      expect(kinds).toEqual(expect.arrayContaining(["user_message", "tool_call"]));

      // The agent worked in its own worktree and wrote the file there.
      const worktree = done.session.worktreePath;
      expect(worktree).toBeTruthy();
      expect(readFileSync(join(worktree as string, "hello.txt"), "utf8").trim()).toBe("hi");

      // MCP tools through the runner proxy: progress and agent follow-ups.
      console.log(`[live] ${provider} progress: ${JSON.stringify(done.session.progress)}`);
      console.log(`[live] ${provider} followups: ${JSON.stringify(done.followups)}`);
      expect(done.session.progress?.text).toBeTruthy();
      expect(done.followups?.source).toBe("agent");
      expect(done.followups?.suggestions.length).toBeGreaterThanOrEqual(2);
      const mcpCalls = [...items.values()].filter(
        (r) => r.item.kind === "tool_call" && r.item.toolKind === "mcp",
      );
      expect(mcpCalls.length).toBeGreaterThanOrEqual(2);

      // Checkpoint diff through the API.
      await waitUntil(async () => {
        const list = (await h.api("GET", `/sessions/${id}/checkpoints`)).body as {
          checkpoints: unknown[];
        };
        return list.checkpoints.length >= 2 ? true : undefined;
      });
      const diff = DiffResult.parse(
        (await h.api("POST", `/sessions/${id}/diff`, { kind: "session" })).body,
      );
      expect(diff.files.map((f) => f.path)).toContain("hello.txt");
      const turnId = diff.turns.at(-1)?.id;
      const turnDiff = DiffResult.parse(
        (await h.api("POST", `/sessions/${id}/diff`, { kind: "turn", turnId })).body,
      );
      expect(turnDiff.files.map((f) => f.path)).toContain("hello.txt");

      // The utility model titled the session after its first message (§7.4).
      const titled = await waitUntil(
        async () => (await h.detail(id)).session.title ?? undefined,
        90_000,
      );
      console.log(`[live] ${provider} title: ${titled}`);

      await h.api("POST", `/sessions/${id}/stop`);
    }, 360_000);
  }
});
