import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions, UserInput } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSession } from "../src/codex/session";

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
const requests = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

const sessions: CodexSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const key of ["FAKE_CODEX_LOG", "FAKE_CODEX_ECHO", "FAKE_CODEX_TURN"]) {
    delete process.env[key];
  }
});

/**
 * Codex keeps only the text of an input, so a brief from the factory, a PM or an automation
 * is recognised by the `clientUserMessageId` sent with it. Through the real send and steer
 * paths, each echoed user message must come back with its sender.
 */
describe("Codex message senders", () => {
  it("keeps who sent a message through turn/start and turn/steer", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "codeden-codex-sender-")), "requests.log");
    process.env.FAKE_CODEX_LOG = log;
    process.env.FAKE_CODEX_ECHO = "1";
    process.env.FAKE_CODEX_TURN = "hang"; // the turn stays open, so it can be steered
    const session = new CodexSession(base, { executable: fakeCodex });
    sessions.push(session);
    const inputs: UserInput[] = [];
    void (async () => {
      for await (const e of session.events as AsyncIterable<AgentEvent>) {
        if (e.type === "item.completed" && e.item.kind === "user_message")
          inputs.push(e.item.input);
      }
    })();
    await session.start();

    await session.send({ text: "## Brief", attachments: [], from: "factory" });
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    await session.steer({
      text: "Message from your project manager:\nAlso",
      attachments: [],
      from: "pm",
    });
    await session.steer({ text: "typed by you", attachments: [] });
    await vi.waitFor(() => expect(inputs).toHaveLength(3));

    expect(inputs.map((i) => i.from)).toEqual(["factory", "pm", undefined]);
    const sent = requests(log).filter(
      (r) => r.method === "turn/start" || r.method === "turn/steer",
    );
    expect(sent.map((r) => [r.method, typeof r.params.clientUserMessageId])).toEqual([
      ["turn/start", "string"],
      ["turn/steer", "string"],
      // The user's own message carries no id: there is no sender to keep.
      ["turn/steer", "undefined"],
    ]);
  });
});
