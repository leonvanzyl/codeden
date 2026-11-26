import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEventToNewEvent, type Session, type UserInput } from "@codeden/contracts";
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
import { removeTree } from "./support/remove-tree";

let dir: string;
let database: Database;
let store: EventStore;
let repo: SessionRepo;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-outbox-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  repo = new SessionRepo(database.db, store);
  outbox = new Outbox(database.db, store);
});

afterEach(async () => {
  vi.useRealTimers();
  database.close();
  await removeTree(dir);
});

const input = (text: string): UserInput => ({ text, attachments: [] });
const texts = () => outbox.list("s1").map((m) => m.input.text);
const unavailable = () => new RunnerCommandError("runner_unavailable", "Runner is not connected");

/** A session service over the real repo and outbox, with a scripted runner. */
function service(opts: { status: Session["status"]; send: (text: string) => Promise<void> }) {
  repo.update("s1", (s) => ({ ...s, status: opts.status }));
  const sent: string[] = [];
  const runner = {
    isConnected: () => true,
    providers: () => [],
    request: vi.fn(async (command: { name: string; input?: UserInput }) => {
      if (command.name !== "session.send") return {};
      await opts.send(command.input?.text ?? "");
      sent.push(command.input?.text ?? "");
      return {};
    }),
  } as unknown as RunnerPort;
  const launcher = { fail: vi.fn(), resume: vi.fn() };
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
  return { sessions, launcher, sent };
}

describe("queued message delivery", () => {
  it("puts a message back in its place when the runner is away, and retries later", async () => {
    vi.useFakeTimers();
    let away = true;
    const { sessions, launcher, sent } = service({
      status: "idle",
      send: async () => {
        if (away) throw unavailable();
      },
    });
    outbox.push("s1", input("one"));
    outbox.push("s1", input("two"));

    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["one", "two"]);
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(repo.get("s1").status).toBe("idle");
    // Delivery pauses instead of looping on the status change.
    await sessions.flushOutbox("s1");
    expect(sent).toEqual([]);

    away = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["one"]);
    expect(texts()).toEqual(["two"]);
  });

  it("delivers held messages as soon as the runner is ready again", async () => {
    let away = true;
    const { sessions, sent } = service({
      status: "idle",
      send: async () => {
        if (away) throw unavailable();
      },
    });
    outbox.push("s1", input("one"));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["one"]);

    away = false;
    sessions.releaseOutboxes();
    await sessions.flushOutbox("s1");
    expect(sent).toEqual(["one"]);
    expect(texts()).toEqual([]);
  });

  it("delivers the next queued message after a failed turn", async () => {
    const { sessions, sent } = service({ status: "failed", send: async () => {} });
    outbox.push("s1", input("after the failure"));
    await sessions.flushOutbox("s1");
    expect(sent).toEqual(["after the failure"]);
  });

  it("keeps the message and fails the session once on a delivery error that is not transient", async () => {
    const { sessions, launcher } = service({
      status: "idle",
      send: async () => {
        throw new RunnerCommandError("provider_error", "The provider refused");
      },
    });
    outbox.push("s1", input("one"));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["one"]);
    expect(launcher.fail).toHaveBeenCalledTimes(1);
    await sessions.flushOutbox("s1");
    expect(launcher.fail).toHaveBeenCalledTimes(1);
  });

  it("queues a message from a PM or the orchestrator while the runner is away; the user's fails", async () => {
    const { sessions } = service({
      status: "idle",
      send: async () => {
        throw unavailable();
      },
    });
    await expect(
      sessions.send(
        "s1",
        { input: input("from the orchestrator"), whenBusy: "queue" },
        "orchestrator",
      ),
    ).resolves.toEqual({ status: "queued" });
    expect(outbox.list("s1").map((m) => [m.input.text, m.from])).toEqual([
      ["from the orchestrator", "orchestrator"],
    ]);
    await expect(
      sessions.send("s1", { input: input("from the user"), whenBusy: "queue" }, "user"),
    ).rejects.toMatchObject({ status: 503, code: "runner_unavailable" });
    // A wake (`reject`) is retried by its scheduler instead.
    await expect(
      sessions.send("s1", { input: input("wake"), whenBusy: "reject" }, "codeden"),
    ).rejects.toMatchObject({ code: "runner_unavailable" });
    expect(texts()).toEqual(["from the orchestrator"]);
  });
});

describe("a send the runner answers too late (#657)", () => {
  const timeout = () => new RunnerCommandError("timeout", "Runner command session.send timed out");
  let turns = 0;
  /** The runner starts the turn and its events reach the server, but the answer doesn't. */
  const startsThenTimesOut = async () => {
    turns += 1;
    store.append([
      agentEventToNewEvent("s1", { type: "thread.started", thread: { id: "t1" } }),
      agentEventToNewEvent("s1", { type: "turn.started", threadId: "t1", turnId: `u${turns}` }),
    ]);
    throw timeout();
  };

  it("counts a queued message as delivered once its turn started: no idle session, no resend", async () => {
    const { sessions, launcher } = service({ status: "idle", send: startsThenTimesOut });
    const one = outbox.push("s1", input("one"), "orchestrator");
    outbox.push("s1", input("two"), "automation");

    await sessions.flushOutbox("s1");
    expect(repo.get("s1").status).toBe("running");
    expect(texts()).toEqual(["two"]);
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(outbox.dequeuedReason("s1", one.id)).toBe("sent");

    // Not held: the turn's end delivers the next message at once, with no retry wait.
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual([]);
  });

  it("answers the sender `sent` when the turn its message started is already running", async () => {
    const { sessions } = service({ status: "idle", send: startsThenTimesOut });
    await expect(
      sessions.send("s1", { input: input("hello"), whenBusy: "queue" }, "user"),
    ).resolves.toEqual({ status: "sent" });
    expect(repo.get("s1").status).toBe("running");
    expect(texts()).toEqual([]);
  });

  it("still puts the message back when no turn started", async () => {
    const { sessions } = service({
      status: "idle",
      send: async () => {
        throw timeout();
      },
    });
    outbox.push("s1", input("one"), "orchestrator");
    await sessions.flushOutbox("s1");
    expect(repo.get("s1").status).toBe("idle");
    expect(texts()).toEqual(["one"]);
  });
});

describe("decorated input", () => {
  it("tells the decorator whether the runner took the turn", async () => {
    let away = true;
    const { sessions, sent } = service({
      status: "idle",
      send: async () => {
        if (away) throw unavailable();
      },
    });
    const delivered = vi.fn();
    const failed = vi.fn();
    sessions.setInputDecorator((_session, raw) => ({
      input: { ...raw, text: `digest\n\n${raw.text}` },
      delivered,
      failed,
    }));
    await expect(
      sessions.send("s1", { input: input("hello"), whenBusy: "queue" }, "user"),
    ).rejects.toMatchObject({ code: "runner_unavailable" });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(delivered).not.toHaveBeenCalled();

    away = false;
    await sessions.send("s1", { input: input("hello"), whenBusy: "queue" }, "user");
    expect(sent).toEqual(["digest\n\nhello"]);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
