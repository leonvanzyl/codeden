import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { CodexAdapter } from "../src/codex/adapter";
import { forkCodexThread } from "../src/codex/fork";

/**
 * Issue #273: every thread CodeDen starts through `codex app-server` is a normal thread in the
 * user's Codex home, so the Codex apps list factory reviewers, builders and PM turns as the
 * user's own recents. Codex 0.160 hides archived threads from that list (`thread/list` without
 * `archived`), but won't resume or fork one until it is unarchived. The fake app-server answers
 * the same way when FAKE_CODEX_ARCHIVE is set.
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

/** A fresh request log and archive state; `archived` are the threads archived to begin with. */
function codexHome(archived: string[] = []): { log: string; archive: string } {
  const dir = mkdtempSync(join(tmpdir(), "codeden-codex-history-"));
  const log = join(dir, "requests.log");
  const archive = join(dir, "archived.json");
  writeFileSync(archive, JSON.stringify(archived));
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_ARCHIVE = archive;
  return { log, archive };
}
const archivedIds = (file: string): string[] => JSON.parse(readFileSync(file, "utf8"));

const open: ProviderSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  for (const key of [
    "FAKE_CODEX_LOG",
    "FAKE_CODEX_ARCHIVE",
    "FAKE_CODEX_REQUESTS",
    "FAKE_CODEX_THREADS",
  ]) {
    delete process.env[key];
  }
});

/** A `spawnAgent` call by the session's thread (`thread-1` in the fake app-server). */
const SPAWN = {
  item: {
    type: "collabAgentToolCall",
    id: "call-spawn",
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: "thread-1",
    receiverThreadIds: [],
    prompt: "Find every caller of parseConfig",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  },
};

async function openSession(opts: Partial<SessionOptions> = {}) {
  const session = await new CodexAdapter({ executable: fakeCodex }).openSession({
    ...base,
    ...opts,
  });
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

describe("Codex threads stay out of the Codex app's history", () => {
  it("archives the thread once its turn has ended", async () => {
    const { archive } = codexHome();
    const { session, events } = await openSession();
    await session.send({
      text: "You are the independent reviewer of pull request #1.",
      attachments: [],
    });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(1), WAIT);
    expect(ended(events)[0]?.type).toBe("turn.completed");

    await vi.waitFor(() => expect(archivedIds(archive)).toEqual(["thread-1"]), WAIT);
  });

  it("resumes an archived thread (unarchived first) instead of starting a new one", async () => {
    const { log } = codexHome(["thread-1"]);
    const { session, events } = await openSession({ resumeToken: "thread-1" });
    // A new thread would lose the conversation Codex holds for the session.
    const threadCalls = requests(log)
      .map((r) => r.method)
      .filter((m) => m.startsWith("thread/"));
    expect(threadCalls).not.toContain("thread/start");

    await session.send({ text: "Next round", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(1), WAIT);
    expect(ended(events)[0]?.type).toBe("turn.completed");
    expect(session.resumeToken()).toBe("thread-1");
    const notices = events.filter((e) => e.type === "item.completed" && e.item.kind === "notice");
    expect(notices).toEqual([]);
  });

  it("forks an archived thread and leaves it archived", async () => {
    const { archive } = codexHome(["thread-source"]);
    await expect(forkCodexThread(fakeCodex, "thread-source", { cwd: tmpdir() })).resolves.toBe(
      "thread-fork-1",
    );
    expect(archivedIds(archive)).toContain("thread-source");
    // The copy too, until a session resumes it.
    expect(archivedIds(archive)).toContain("thread-fork-1");
  });

  it("unarchives and resumes the thread before the next turn, then archives it again", async () => {
    const { log, archive } = codexHome();
    const { session, events } = await openSession();
    await session.send({ text: "First", attachments: [] });
    await vi.waitFor(() => expect(archivedIds(archive)).toEqual(["thread-1"]), WAIT);

    await session.send({ text: "Second", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(2), WAIT);
    expect(ended(events).map((e) => e.type)).toEqual(["turn.completed", "turn.completed"]);
    await vi.waitFor(() => expect(archivedIds(archive)).toEqual(["thread-1"]), WAIT);

    const calls = requests(log)
      .map((r) => r.method)
      .filter((m) => m.startsWith("thread/") || m === "turn/start");
    expect(calls).toEqual([
      "thread/start",
      "turn/start",
      "thread/archive",
      "thread/unarchive",
      "thread/resume",
      "turn/start",
      "thread/archive",
    ]);
    // The same thread throughout: no second `session.updated` with another resume token.
    const tokens = events.flatMap((e) => (e.type === "session.updated" ? [e.resumeToken] : []));
    expect(tokens).toEqual(["thread-1"]);
  });

  it("archives the thread when the session closes", async () => {
    const { archive } = codexHome();
    const { session } = await openSession();
    expect(archivedIds(archive)).toEqual([]);
    await session.close();
    expect(archivedIds(archive)).toEqual(["thread-1"]);
  });

  it("keeps a thread whose agent spawned sub-agents loaded until the session closes", async () => {
    const { archive } = codexHome();
    const scripted = join(mkdtempSync(join(tmpdir(), "codeden-codex-history-")), "spawn.json");
    writeFileSync(
      scripted,
      JSON.stringify([{ method: "item/started", notify: true, params: SPAWN }]),
    );
    process.env.FAKE_CODEX_REQUESTS = scripted;
    const { session, events } = await openSession();
    await session.send({ text: "Use a helper agent", attachments: [] });
    await vi.waitFor(() => expect(ended(events)).toHaveLength(1), WAIT);
    // A later turn may still talk to the agent: unloading the thread could cut it off.
    await new Promise((r) => setTimeout(r, 200));
    expect(archivedIds(archive)).toEqual([]);

    await session.close();
    expect(archivedIds(archive)).toEqual(["thread-1"]);
  });
});

describe("hiding CodeDen's existing threads from the Codex apps", () => {
  /** The user's Codex home: CodeDen's threads and one of the user's own. */
  function withThreads(archived: string[] = []) {
    const home = codexHome(archived);
    const threads = join(mkdtempSync(join(tmpdir(), "codeden-codex-history-")), "threads.json");
    writeFileSync(
      threads,
      JSON.stringify([
        { id: "codeden-1", preview: "You are the independent reviewer of pull request #1." },
        { id: "users-own", preview: "Help me plan my week" },
        { id: "codeden-2", preview: "You are the builder" },
        { id: "codeden-3", preview: "Scout the repo" },
      ]),
    );
    process.env.FAKE_CODEX_THREADS = threads;
    return home;
  }

  it("lists only the given threads the Codex apps still show", async () => {
    withThreads(["codeden-3"]);
    const adapter = new CodexAdapter({ executable: fakeCodex });
    expect(adapter.capabilities().vendorHistory).toBe(true);
    const entries = await adapter.listVendorHistory([
      "codeden-1",
      "codeden-2",
      "codeden-3",
      "gone",
    ]);
    expect(entries.map((e) => [e.resumeToken, e.preview])).toEqual([
      ["codeden-1", "You are the independent reviewer of pull request #1."],
      ["codeden-2", "You are the builder"],
    ]);
    expect(entries[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("archives exactly the given threads and never the user's own", async () => {
    const { log, archive } = withThreads(["codeden-3"]);
    const adapter = new CodexAdapter({ executable: fakeCodex });
    const result = await adapter.hideVendorHistory(["codeden-1", "codeden-2", "missing"]);
    expect(result).toEqual({
      hidden: ["codeden-1", "codeden-2"],
      missing: ["missing"],
      failed: [],
    });
    expect(archivedIds(archive).sort()).toEqual(["codeden-1", "codeden-2", "codeden-3"]);
    const archivedBy = requests(log)
      .filter((r) => r.method === "thread/archive")
      .map((r) => r.params.threadId);
    expect(archivedBy).not.toContain("users-own");
    expect(await adapter.listVendorHistory(["codeden-1", "codeden-2"])).toEqual([]);
  });
});
