import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryItem, UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RunnerCommandError } from "../src/runner/client";
import { BUILDER_RESUME } from "../src/services/factory/prompts";
import { BUILDER_FAILED_REASON } from "../src/services/factory/turn-race";
import type { RunnerPort } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #96: a message delivered while a turn runs must be queued (or steered), never sent as a
 * second turn, and the provider's "A turn is already running" must never fail the session.
 */

let dir: string;
let database: Database;
let store: EventStore;
let repo: SessionRepo;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-turn-running-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  repo = new SessionRepo(database.db, store);
  outbox = new Outbox(database.db, store);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (text: string): UserInput => ({ text, attachments: [] });

/**
 * A session service over the real repo and outbox, with a runner that behaves like a provider
 * session: one turn at a time, and `session.send` during a turn fails the way runners before
 * the `turn_running` code reported it (`command_failed`, "A turn is already running").
 */
function providerLike(opts: { turnRunning?: boolean } = {}) {
  repo.update("s1", (s) => ({ ...s, status: "idle" }));
  const state = { turn: opts.turnRunning ?? false };
  const sent: string[] = [];
  const request = vi.fn(async (command: { name: string; input?: UserInput }) => {
    if (command.name !== "session.send") return {};
    if (state.turn) throw new RunnerCommandError("command_failed", "A turn is already running");
    state.turn = true;
    sent.push(command.input?.text ?? "");
    return {};
  });
  const runner = { isConnected: () => true, providers: () => [], request } as unknown as RunnerPort;
  // Like the real launcher: a failure marks the session failed.
  const launcher = {
    fail: vi.fn((id: string) => repo.update(id, (s) => ({ ...s, status: "failed" }))),
    resume: vi.fn(),
  };
  const sessions = new SessionService({
    repo,
    runner,
    outbox,
    launcher: launcher as unknown as SessionLauncher,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
    outboxRetryMs: 1_000,
  } as unknown as SessionServiceDeps);
  /** The provider ends its turn; the server sees the session go idle and drains its queue. */
  const endTurn = async () => {
    state.turn = false;
    repo.update("s1", (s) => (s.status === "running" ? { ...s, status: "idle" } : s));
    await sessions.flushOutbox("s1");
  };
  return { sessions, launcher, sent, state, request, endTurn };
}

describe("deliveries racing a running turn (#96)", () => {
  it("queues the second of two deliveries racing an idle session, and delivers both in order", async () => {
    const { sessions, launcher, sent, endTurn } = providerLike();
    // A factory revise message and a PM message arrive in the same moment.
    const results = await Promise.allSettled([
      sessions.send("s1", { input: input("revise"), whenBusy: "queue" }, "factory"),
      sessions.send("s1", { input: input("pm note"), whenBusy: "queue" }, "pm"),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: { status: "sent" } },
      { status: "fulfilled", value: { status: "queued" } },
    ]);
    // The first message's turn is running; nothing reverted it to idle.
    expect(repo.get("s1").status).toBe("running");
    await endTurn();
    expect(sent).toEqual(["revise", "pm note"]);
    expect(launcher.fail).not.toHaveBeenCalled();
  });

  it("never fails the session when a queued-message flush races a send", async () => {
    const { sessions, launcher, sent, endTurn } = providerLike();
    outbox.push("s1", input("queued earlier"), "pm");
    // The session just went idle (flush scheduled) as the factory sends its next message.
    await Promise.allSettled([
      sessions.send("s1", { input: input("revise"), whenBusy: "queue" }, "factory"),
      sessions.flushOutbox("s1"),
    ]);
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(repo.get("s1").status).toBe("running");
    await endTurn();
    expect(sent).toEqual(["revise", "queued earlier"]);
  });

  it("treats the runner's 'turn already running' as retryable: the message waits for the turn", async () => {
    // The runner has a turn the server doesn't know about yet (it still shows idle).
    const { sessions, launcher, sent, endTurn } = providerLike({ turnRunning: true });
    outbox.push("s1", input("queued"), "pm");
    await sessions.flushOutbox("s1");
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(repo.get("s1").status).not.toBe("failed");
    await expect(
      sessions.send("s1", { input: input("nudge"), whenBusy: "queue" }, "factory"),
    ).resolves.toEqual({ status: "queued" });
    expect(outbox.list("s1").map((m) => m.input.text)).toEqual(["queued", "nudge"]);

    await endTurn();
    await endTurn();
    expect(sent).toEqual(["queued", "nudge"]);
  });

  it("delivers right away when the turn that refused a message ended before the refusal was handled", async () => {
    const { sessions, launcher, sent, state, request } = providerLike({ turnRunning: true });
    // The refusal and the end of the turn reach the server together.
    request.mockImplementationOnce(async () => {
      state.turn = false;
      repo.update("s1", (s) => ({ ...s, status: "idle" }));
      throw new RunnerCommandError("turn_running", "A turn is already running");
    });
    await expect(
      sessions.send("s1", { input: input("late"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    await new Promise((resolve) => setImmediate(resolve));
    await vi.waitFor(() => expect(sent).toEqual(["late"]));
    expect(launcher.fail).not.toHaveBeenCalled();
  });

  it("answers a wake (`reject`) with 409 turn_running instead of failing", async () => {
    const { sessions, launcher } = providerLike({ turnRunning: true });
    await expect(
      sessions.send("s1", { input: input("wake"), whenBusy: "reject" }, "codeden"),
    ).rejects.toMatchObject({ status: 409, code: "turn_running" });
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(outbox.count("s1")).toBe(0);
  });
});

describe("factory builders hit by 'turn already running' (#96)", () => {
  let env: FactoryEnv;
  afterEach(() => env?.close());

  const tick = () => env.factory.tick(env.project.id);
  const item = (id: string) => env.factory.data.item(id) as FactoryItem;
  const resumes = () => env.messages.filter((m) => m.text === BUILDER_RESUME);
  /** What a lost delivery race did to a builder: the session service failed it. */
  const raceFails = async (sessionId: string) => {
    await env.setStatus(sessionId, "failed");
    env.inbox.raiseRunFailed(
      env.repo.get(sessionId),
      `send-${Date.now()}`,
      "A turn is already running",
    );
  };

  /** A software factory with one item whose builder is at work. */
  async function building(): Promise<{ id: string; builderId: string }> {
    env = createFactoryEnv();
    env.factory.setMode(env.project.id, {
      mode: "software_factory",
      limits: { ...env.project.factoryLimits, autoMerge: true },
    } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
    const created = env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "issue:91",
      title: "Transcript search",
      summary: "Search a session's transcript",
      source: "discovery",
      stage: "backlog",
      type: "feature",
      investigation: {
        kind: "analysis",
        outcome: "implement",
        summary: "Missing",
        details: null,
        testPath: null,
        at: new Date().toISOString(),
      },
      score: 0.5,
      acceptanceCriteria: ["Search finds a message"],
      issue: { number: 91, url: "https://github.com/acme/app/issues/91", title: "Search" },
    });
    await tick();
    expect(item(created.id).stage).toBe("building");
    return { id: created.id, builderId: item(created.id).builderSessionId as string };
  }

  it("does not fail the item when its builder failed with this error: the builder carries on", async () => {
    const { id, builderId } = await building();
    await raceFails(builderId);
    await tick();

    expect(item(id)).toMatchObject({ stage: "building", reason: null });
    expect(resumes()).toEqual([{ sessionId: builderId, text: BUILDER_RESUME }]);
    expect(env.repo.get(builderId).status).toBe("running");
    await tick();
    expect(resumes()).toHaveLength(1);

    // A real failure after that still fails the item.
    await env.setStatus(builderId, "failed");
    env.inbox.raiseRunFailed(env.repo.get(builderId), "turn-9:failed", "The model is overloaded");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", reason: BUILDER_FAILED_REASON });
  });

  it("puts items this error failed back into building, once, and brings their builder back", async () => {
    const { id, builderId } = await building();
    await raceFails(builderId);
    // What the factory did before the fix: failed the item, then archived its builder.
    const at = new Date().toISOString();
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      reason: BUILDER_FAILED_REASON,
      finishedAt: at,
      sessionsArchivedAt: at,
    }));
    env.repo.update(builderId, (s) => ({ ...s, status: "stopped", archivedAt: at }));

    await tick();
    expect(item(id)).toMatchObject({
      stage: "building",
      reason: null,
      finishedAt: null,
      sessionsArchivedAt: null,
    });
    expect(resumes()).toEqual([{ sessionId: builderId, text: BUILDER_RESUME }]);
    expect(env.repo.get(builderId)).toMatchObject({ status: "running", archivedAt: null });
    await tick();
    expect(resumes()).toHaveLength(1);
  });

  it("leaves items that failed for other reasons alone", async () => {
    const { id, builderId } = await building();
    await env.setStatus(builderId, "failed");
    env.inbox.raiseRunFailed(env.repo.get(builderId), "start", "Could not open the session");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", reason: BUILDER_FAILED_REASON });
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(resumes()).toEqual([]);
  });
});
