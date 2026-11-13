import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RunnerCommandError } from "../src/runner/client";
import type { RunnerPort } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

/**
 * Issue #96: a message delivered while a turn runs must be queued (or steered), never sent as a
 * second turn, keep its place in arrival order, and the provider's "A turn is already running"
 * must never fail the session. The factory side is in `factory-turn-race.test.ts`.
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
const texts = () => outbox.list("s1").map((m) => m.input.text);
/** Let pending `setImmediate` work (a scheduled queue flush) and its promises run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

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
    await settle();
    expect(sent).toEqual(["late"]);
    expect(launcher.fail).not.toHaveBeenCalled();
  });

  it("delivers what queued up when the turn ended before the runner's answer to a send", async () => {
    const { sessions, sent, state, request } = providerLike();
    let answer = () => {};
    request.mockImplementationOnce(async (command) => {
      state.turn = true;
      sent.push(command.input?.text ?? "");
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return {};
    });
    const first = sessions.send("s1", { input: input("first"), whenBusy: "queue" }, "factory");
    await settle();
    expect(sent).toEqual(["first"]);
    await expect(
      sessions.send("s1", { input: input("second"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    // The turn ends before the runner's answer is handled: the flush its end triggers finds the
    // delivery still in flight.
    state.turn = false;
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["second"]);

    answer();
    await expect(first).resolves.toEqual({ status: "sent" });
    await settle();
    expect(sent).toEqual(["first", "second"]);
    expect(texts()).toEqual([]);
  });

  it("keeps arrival order when a busy runner refuses a send while another message arrives", async () => {
    // The server still shows the session idle; the runner is in a turn.
    const { sessions, sent, request, endTurn } = providerLike({ turnRunning: true });
    let refuse = () => {};
    request.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        refuse = resolve;
      });
      throw new RunnerCommandError("turn_running", "A turn is already running");
    });
    const first = sessions.send("s1", { input: input("first"), whenBusy: "queue" }, "factory");
    await settle();
    await expect(
      sessions.send("s1", { input: input("second"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    refuse();
    await expect(first).resolves.toEqual({ status: "queued" });
    expect(texts()).toEqual(["first", "second"]);

    await endTurn();
    await endTurn();
    expect(sent).toEqual(["first", "second"]);
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
