import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSession } from "../src/codex/session";

/**
 * Issue #281: CodeDen archives a session's Codex thread after each turn, which unloads it from
 * the app-server, and gives the archive 5 s. An archive that answers later but still succeeds
 * must not leave the session sending turns to a thread the app-server no longer has loaded
 * ("thread not found"): the next turn still runs on the same thread.
 */

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

type Logged = { method: string; params: Record<string, unknown> };
const requests = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

function codexHome(): { log: string; archive: string } {
  const dir = mkdtempSync(join(tmpdir(), "codeden-codex-reopen-"));
  const log = join(dir, "requests.log");
  const archive = join(dir, "archived.json");
  writeFileSync(archive, "[]");
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_ARCHIVE = archive;
  return { log, archive };
}
const archivedIds = (file: string): string[] => JSON.parse(readFileSync(file, "utf8"));

const open: CodexSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  for (const key of [
    "FAKE_CODEX_LOG",
    "FAKE_CODEX_ARCHIVE",
    "FAKE_CODEX_ARCHIVE_DELAY_MS",
    "FAKE_CODEX_TURN",
  ]) {
    delete process.env[key];
  }
});

/** A short archive limit, so a slow archive runs past it without slowing the suite. */
const ARCHIVE_TIMEOUT_MS = 100;

async function openSession() {
  const session = new CodexSession(base, {
    executable: fakeCodex,
    archiveTimeoutMs: ARCHIVE_TIMEOUT_MS,
  });
  await session.start();
  open.push(session);
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of session.events as AsyncIterable<AgentEvent>) events.push(e);
  })();
  return { session, events };
}

/** Inside Vitest's 5 s test timeout, so a wait that runs out says what it waited for. */
const WAIT = { timeout: 3_000 };

const ended = (events: AgentEvent[]) =>
  events.filter(
    (e) => e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted",
  );
/** The thread and turn requests the app-server received, in order. */
const threadCalls = (log: string) =>
  requests(log)
    .map((r) => r.method)
    .filter((m) => m.startsWith("thread/") || m === "turn/start");

describe("a Codex session's thread stays usable after it was archived", () => {
  it("runs the next turn on the same thread when archiving answered after its time limit", async () => {
    const { log, archive } = codexHome();
    // Longer than the session's archive limit, but the archive still succeeds.
    process.env.FAKE_CODEX_ARCHIVE_DELAY_MS = String(ARCHIVE_TIMEOUT_MS * 4);
    const { session, events } = await openSession();
    await session.send({ text: "First", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(1), WAIT);
    // The archive went through after all: the app-server has unloaded the thread.
    await vi.waitFor(() => expect(archivedIds(archive)).toEqual(["thread-1"]), WAIT);

    await session.send({ text: "Second", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(2), WAIT);
    expect(ended(events).map((e) => e.type)).toEqual(["turn.completed", "turn.completed"]);
    expect(session.resumeToken()).toBe("thread-1");
    // Reopened before the turn, so the turn didn't have to be retried.
    await vi.waitFor(
      () =>
        expect(threadCalls(log)).toEqual([
          "thread/start",
          "turn/start",
          "thread/archive",
          "thread/unarchive",
          "thread/resume",
          "turn/start",
          "thread/archive",
        ]),
      WAIT,
    );
  });

  it("reopens the thread and retries a turn once when Codex says the thread is not found", async () => {
    const { log, archive } = codexHome();
    const { session, events } = await openSession();
    // Something unloaded the thread behind the session's back (an archive that ran late).
    writeFileSync(archive, JSON.stringify(["thread-1"]));

    await session.send({ text: "Go", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(1), WAIT);
    expect(ended(events)[0]?.type).toBe("turn.completed");
    await vi.waitFor(
      () =>
        expect(threadCalls(log)).toEqual([
          "thread/start",
          "turn/start",
          "thread/unarchive",
          "thread/resume",
          "turn/start",
          "thread/archive",
        ]),
      WAIT,
    );
    // Same thread, so no new resume token is reported.
    const tokens = events.flatMap((e) => (e.type === "session.updated" ? [e.resumeToken] : []));
    expect(tokens).toEqual(["thread-1"]);
  });

  it("gives up after one retry when the thread is still not found", async () => {
    const { log } = codexHome();
    process.env.FAKE_CODEX_TURN = "lost";
    const { session } = await openSession();

    await expect(session.send({ text: "Go", attachments: [] })).rejects.toThrow(/thread not found/);
    const calls = threadCalls(log);
    expect(calls.filter((m) => m === "turn/start")).toHaveLength(2);
    expect(calls.filter((m) => m === "thread/resume")).toHaveLength(1);
    expect(calls.filter((m) => m === "thread/unarchive")).toHaveLength(1);
  });
});
