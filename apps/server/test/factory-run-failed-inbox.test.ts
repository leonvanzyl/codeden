import {
  type AgentEvent,
  agentEventToNewEvent,
  type InboxItem,
  type RawEventEnvelope,
  type RunnerEventMessage,
  type Session,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import { derivedEvents } from "../src/events/projection-db";
import { RunnerCommandError } from "../src/runner/client";
import { ProviderAvailability, type ProviderRunnable } from "../src/services/factory/availability";
import { buildDigest } from "../src/services/factory/digest";
import { localDay } from "../src/services/factory/policy";
import { RETRY_TEXT, retryRunFailed } from "../src/services/inbox-retry";
import { RunFailedSettler } from "../src/services/inbox-settle";
import { deriveNotices } from "../src/services/orchestration/notices";
import { type RunnerPort, toServiceError } from "../src/services/runner-port";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { MemoryProjection } from "./support/memory-projection";

// Issue #275: a factory reviewer that couldn't start on its provider left `run_failed` inbox
// items waiting on the user, though the factory restarted the review elsewhere by itself; the
// items never settled (not even once the PR merged), and every failed Retry added another one.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, openPr, review } = factorySteps(() => env);

const TOO_OLD = "Gemini CLI 0.36.0 is older than 0.68.0, the oldest CodeDen supports.";

/** Let the background provider detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));

let seq = 0;
/** The runner's report of a session its provider refused to open (a CLI too old). */
function refusedOpen(sessionId: string, message = TOO_OLD) {
  const msg: RunnerEventMessage = {
    type: "event",
    seq: ++seq,
    ts: new Date().toISOString(),
    event: {
      kind: "session.process",
      sessionId,
      state: "crashed",
      error: { code: "open_failed", message, kind: "setup" },
    },
  };
  ingestRunnerEvent(env.db.db, env.store, "home", msg);
}

/** The launcher's failure handling (`fail` reads only the sessions and the inbox). */
const launcher = () =>
  new SessionLauncher({ repo: env.repo, inbox: env.inbox } as unknown as LauncherDeps);

const runFailed = (sessionId: string, status: InboxItem["status"] = "open"): InboxItem[] =>
  env.inbox
    .list({ sessionId, status })
    .filter((i) => i.kind === "run_failed" && i.sessionId === sessionId);

/** A reviewer on Gemini that the runner refuses to open; the factory falls back to Claude. */
async function failedReviewer() {
  env = createFactoryEnv({ providers: ["claude", "codex", "gemini"] });
  enable("dark_factory", {
    tuning: { builderProvider: "claude", reviewerProvider: "gemini", reviewerFallback: "any" },
  });
  await tick();
  await settle();
  const created = backlogItem("Add a counter", 3);
  await tick();
  await openPr(created.id);
  await tick();
  const failed = item(created.id).reviewerSessionId as string;
  expect(env.repo.get(failed).provider).toBe("gemini");
  refusedOpen(failed);
  // Then the runner answers the start command, and the launcher fails the session.
  launcher().fail(
    failed,
    "start",
    new RunnerCommandError("open_failed", `Could not open the session: ${TOO_OLD}`),
  );
  await tick();
  await tick();
  const replacement = item(created.id).reviewerSessionId as string;
  expect(replacement).not.toBe(failed);
  expect(env.repo.get(replacement).provider).not.toBe("gemini");
  return { id: created.id, failed, replacement };
}

/** A session a person started (not the factory) for `workKey`. */
async function userSession(workKey = "issue:9", purpose = "Fix the parser"): Promise<Session> {
  const res = await env.sessions.start({
    projectId: env.project.id,
    purpose,
    workKey,
    startedBy: { kind: "user" },
  } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
  return env.repo.get((res as { sessionId: string }).sessionId);
}

/** The session's root turn runs and completes. */
function turnCompletes(sessionId: string, turnId = "u1"): void {
  const threadId = `t-${sessionId.slice(0, 8)}`;
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: threadId } } as AgentEvent,
    { type: "turn.started", threadId, turnId },
    { type: "turn.completed", threadId, turnId },
  ];
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

const settler = () =>
  new RunFailedSettler({
    store: env.store,
    repo: env.repo,
    inbox: env.inbox,
    factoryItems: (projectId) => env.factory.data.items(projectId),
  });

/** A moment later, so timestamps compare in order. */
const moment = () => new Promise((r) => setTimeout(r, 5));

describe("run_failed items of factory sessions (#275)", () => {
  it("leaves nothing waiting on the user when the factory falls back from the provider", async () => {
    const { failed } = await failedReviewer();
    expect(runFailed(failed)).toEqual([]);
    // The failure stays in the history, settled as the factory's to handle.
    const [recorded, ...more] = runFailed(failed, "resolved");
    expect(more).toEqual([]);
    expect(recorded).toMatchObject({
      notify: "factory",
      body: TOO_OLD,
      resolution: { by: "factory" },
    });
    expect(env.inbox.counts().byKind.run_failed).toBeUndefined();
  });

  it("reports the handled failure in the daily digest, not as waiting on the user", async () => {
    const { failed } = await failedReviewer();
    const [recorded] = runFailed(failed, "resolved");
    // As if it had been left open (before this fix): still not waiting on the user.
    const open = { ...(recorded as InboxItem), status: "open" as const };
    const digest = buildDigest({
      projectId: env.project.id,
      projectName: env.project.name,
      day: localDay(),
      items: [],
      needsYou: [],
      inbox: [open],
      settled: runFailed(failed, "resolved"),
      spend: { usd: 0, tokens: 0 },
      limits: env.project.factoryLimits,
      pausedReason: null,
    });
    expect(digest.waiting).toEqual([]);
    expect(digest.handled).toEqual([
      { title: recorded?.title, detail: TOO_OLD, inboxItemId: recorded?.id },
    ]);
    expect(digest.text).toMatch(/Failures it handled on its own \(1\)/);
  });

  it("stays settled once the PR merges", async () => {
    const { id, failed } = await failedReviewer();
    review(id);
    await tick();
    expect(["watching", "merged"]).toContain(item(id).stage);
    expect(runFailed(failed)).toEqual([]);
  });

  it("settles items left open from before, at startup", async () => {
    env = createFactoryEnv();
    enable("software_factory");
    const created = backlogItem();
    await tick();
    const builder = env.repo.get(item(created.id).builderSessionId as string);
    // An item raised before failures of factory sessions were settled at once.
    const old = env.inbox.raiseRunFailed(builder, "start", "spawn opencode.exe ENOENT");
    env.inbox.put({ ...old, status: "open", resolvedAt: null, resolution: null });
    expect(runFailed(builder.id)).toHaveLength(1);
    const settled = settler().sweep();
    expect(settled.map((i) => i.resolution)).toEqual([expect.objectContaining({ by: "factory" })]);
    expect(runFailed(builder.id)).toEqual([]);
  });
});

describe("run_failed items settle when their work moves on (#275)", () => {
  it("when a pull request of the work merges", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    expect(settler().sweep()).toEqual([]);
    env.repo.update(s.id, (cur) => ({
      ...cur,
      pr: { number: 12, url: "https://github.com/acme/app/pull/12", state: "merged" },
    }));
    const [settled] = settler().sweep();
    expect(settled).toMatchObject({
      status: "resolved",
      resolution: { by: "codeden", note: "PR #12 merged" },
    });
    expect(runFailed(s.id)).toEqual([]);
  });

  it("when another session of the same work key succeeds", async () => {
    env = createFactoryEnv();
    const first = await userSession("issue:21");
    env.inbox.raiseRunFailed(first, "start", "spawn opencode.exe ENOENT");
    await moment();
    const second = await userSession("issue:21");
    turnCompletes(second.id);
    const [settled] = settler().sweep();
    expect(settled?.sessionId).toBe(first.id);
    expect(settled?.resolution).toMatchObject({ note: expect.stringMatching(/Another session/) });
  });

  it("when the session itself ran again", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    await moment();
    turnCompletes(s.id);
    expect(settler().sweep()[0]?.resolution).toMatchObject({ note: "The session ran again" });
  });

  it("when the factory item of the work is done", async () => {
    env = createFactoryEnv();
    const created = backlogItem("Add a counter", 5);
    const s = await userSession("issue:5");
    env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    env.factory.data.updateItem(created.id, (i) => ({ ...i, stage: "merged" }));
    expect(settler().sweep()[0]?.resolution).toMatchObject({
      note: "The factory finished this work",
    });
  });

  it("keeps one item per work key and cause", async () => {
    env = createFactoryEnv();
    const first = await userSession("issue:30");
    env.inbox.raiseRunFailed(first, "start", "spawn opencode.exe ENOENT");
    await moment();
    const second = await userSession("issue:30");
    env.inbox.raiseRunFailed(second, "start", "spawn opencode.exe ENOENT");
    settler().sweep();
    expect(runFailed(first.id)).toEqual([]);
    expect(runFailed(second.id)).toHaveLength(1);
  });

  it("runs at startup", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    env.repo.update(s.id, (cur) => ({
      ...cur,
      pr: { number: 4, url: "https://github.com/acme/app/pull/4", state: "closed" },
    }));
    const service = settler();
    service.start();
    await settle();
    service.stop();
    expect(runFailed(s.id)).toEqual([]);
  });
});

describe("what doesn't settle (#275 review)", () => {
  it("not a session of other work on the same issue (a reviewer, a triage)", async () => {
    env = createFactoryEnv();
    const s = await userSession("issue:40");
    env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    await moment();
    const reviewer = await userSession("issue:40", "Review the parser fix");
    turnCompletes(reviewer.id);
    expect(settler().sweep()).toEqual([]);
    expect(runFailed(s.id)).toHaveLength(1);
  });

  it("not the factory's own items, even one about a factory session", async () => {
    env = createFactoryEnv();
    enable("software_factory");
    const created = backlogItem();
    await tick();
    const builder = env.repo.get(item(created.id).builderSessionId as string);
    // A stuck item without a pull request: `run_failed`, needs you, about the builder.
    const stuck = env.inbox.put({
      ...env.inbox.raiseRunFailed(builder, "start", "x"),
      id: `inbox:factory-stuck:${created.id}`,
      status: "open",
      notify: "needs_you",
      title: "Stuck: Add a counter",
      resolvedAt: null,
      resolution: null,
    });
    // A failed run of a factory session someone flagged for a person, outside the factory's ids.
    const flagged = env.inbox.put({ ...stuck, id: "inbox:flagged", title: "Flagged" });
    // Neither is a failure the factory handles by itself: both still wait on the user.
    expect(settler().sweep()).toEqual([]);
    expect(env.inbox.get(flagged.id).status).toBe("open");
    await moment();
    turnCompletes(builder.id);
    const settled = settler().sweep();
    expect(settled.map((i) => i.id)).toEqual(["inbox:flagged"]);
    expect(settled[0]?.resolution).toMatchObject({ by: "codeden", note: "The session ran again" });
    expect(env.inbox.get(stuck.id).status).toBe("open");
  });
});

describe("Retry's provider check (#275 review)", () => {
  it("detects again before refusing, so a CLI just updated isn't refused", async () => {
    env = createFactoryEnv({ providers: ["claude", "gemini"] });
    env.detected.gemini = {
      installed: true,
      version: "0.36.0",
      supported: false,
      issues: [
        {
          code: "version_unsupported",
          message: "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it.",
          fix: { kind: "upgrade", command: "npm install -g @google/gemini-cli@latest" },
          minVersion: "0.68.0",
        },
      ],
    };
    enable("software_factory");
    await tick();
    await settle();
    expect((await env.factory.providerRunnableNow("gemini")).runnable).toBe(false);
    // The user updates Gemini CLI; the factory's cached detection is still the old one.
    env.detected.gemini = {};
    expect(env.factory.providerRunnable("gemini").runnable).toBe(false);
    expect((await env.factory.providerRunnableNow("gemini")).runnable).toBe(true);
  });

  it("leaves out the factory's back-off after its own sessions failed there", () => {
    const runner = { isConnected: () => false } as unknown as RunnerPort;
    const availability = new ProviderAvailability({ runner, now: () => new Date() });
    availability.markFailed("codex", "failing to run reviews", null);
    expect(availability.runnable("codex").runnable).toBe(false);
    expect(availability.runnable("codex", "Codex", { ignoreFailures: true }).runnable).toBe(true);
  });
});

describe("Retry of a failed run (#275)", () => {
  const RUNNABLE: ProviderRunnable = {
    runnable: true,
    reason: null,
    until: null,
    detail: null,
    fix: null,
    message: null,
  };
  const TOO_OLD_PROVIDER: ProviderRunnable = {
    runnable: false,
    reason: "too old (0.36.0, needs 0.68.0+)",
    until: null,
    detail: "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it.",
    fix: { kind: "upgrade", command: "npm install -g @google/gemini-cli@latest" },
    message:
      "Gemini CLI is too old (0.36.0, needs 0.68.0+): run `npm install -g @google/gemini-cli@latest`",
  };

  it("is refused with the reason while the provider can't run", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    const failed = env.inbox.raiseRunFailed(s, "start", TOO_OLD);
    const sent: string[] = [];
    const deps = {
      inbox: env.inbox,
      repo: env.repo,
      sessions: {
        send: async (id: string) => {
          sent.push(id);
          return { status: "sent" as const };
        },
      },
      runnable: () => TOO_OLD_PROVIDER,
    };
    await expect(retryRunFailed(deps, failed.id)).rejects.toMatchObject({
      status: 409,
      code: "provider_unavailable",
      message: expect.stringMatching(/Gemini CLI is too old.*npm install -g/),
    });
    expect(sent).toEqual([]);
    expect(env.inbox.get(failed.id)).toMatchObject({ status: "open", attempts: 1 });
  });

  it("that fails again updates the same item in place", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    // The first start: the provider refused to open it.
    refusedOpen(s.id);
    const [failed] = runFailed(s.id);
    expect(failed).toBeDefined();
    const before = env.inbox.counts().open;
    const deps = {
      inbox: env.inbox,
      repo: env.repo,
      sessions: {
        send: async (id: string, req: { input: { text: string } }) => {
          expect(req.input.text).toBe(RETRY_TEXT);
          // The runner refuses again: it reports the crash, then answers the command.
          refusedOpen(id);
          throw toServiceError(
            new RunnerCommandError("open_failed", `Could not open the session: ${TOO_OLD}`),
          );
        },
      },
      runnable: () => RUNNABLE,
    };
    await expect(retryRunFailed(deps, failed?.id as string)).rejects.toMatchObject({
      code: "retry_failed",
      message: expect.stringMatching(/Could not open the session/),
    });
    expect(env.inbox.counts().open).toBe(before);
    expect(runFailed(s.id)).toEqual([
      expect.objectContaining({ id: failed?.id, attempts: 2, body: TOO_OLD }),
    ]);

    // A failure the runner didn't report (it was away) updates it too.
    deps.sessions.send = async () => {
      throw toServiceError(new RunnerCommandError("runner_unavailable", "The runner is away"));
    };
    await expect(retryRunFailed(deps, failed?.id as string)).rejects.toMatchObject({
      status: 503,
    });
    expect(runFailed(s.id)).toEqual([
      expect.objectContaining({ attempts: 3, body: "The runner is away" }),
    ]);
    expect(env.inbox.counts().open).toBe(before);
  });

  it("that starts resolves the item", async () => {
    env = createFactoryEnv();
    const s = await userSession();
    const failed = env.inbox.raiseRunFailed(s, "start", "Request failed: 401");
    const item = await retryRunFailed(
      {
        inbox: env.inbox,
        repo: env.repo,
        sessions: env.sessions,
        runnable: () => RUNNABLE,
      },
      failed.id,
    );
    expect(item).toMatchObject({ status: "resolved", resolution: { note: "retry" } });
    expect(env.messages).toEqual([{ sessionId: s.id, text: RETRY_TEXT }]);
  });
});

describe("a session that fails again (#275)", () => {
  // A PM-started session reporting to the orchestrator: every failure must reach the PM, the
  // orchestrator and `session.failed` automations, though the inbox item is updated in place.
  const reporting: Session = {
    ...sampleSession,
    status: "running",
    projectId: "p1",
    startedBy: { kind: "pm", id: "pm1", reportTo: "orchestrator" },
  };

  /** Apply the agent events, then derive notices from the events the reducer produced. */
  function noticesOf(p: MemoryProjection, events: AgentEvent[]) {
    let seq = 0;
    const envelopes = events.flatMap((e) =>
      derivedEvents(p.apply("s1", e)).map((n) => ({
        seq: ++seq,
        ts: "2026-11-14T12:00:00.000Z",
        sessionId: n.sessionId,
        type: n.type,
        payload: n.payload,
      })),
    );
    return deriveNotices(envelopes as RawEventEnvelope[], {
      session: (id) => p.sessions.get(id)?.session,
      finalMessage: () => null,
    }).map((d) => [d.notice.id, d.notice.type, d.notice.target]);
  }

  const failedTurn = (turnId: string, message: string): AgentEvent[] => [
    { type: "turn.started", threadId: "t1", turnId },
    { type: "turn.failed", threadId: "t1", turnId, error: { message } },
  ];

  it("still tells the PM, the orchestrator and automations about every failure", () => {
    const p = new MemoryProjection();
    p.addSession(reporting);
    p.apply("s1", { type: "thread.started", thread: { id: "t1" } });
    expect(noticesOf(p, failedTurn("u1", "Request failed: 401"))).toEqual([
      ["session.failed:inbox:s1:u1:failed", "session.failed", "pm"],
      ["session.failed:orchestrator:inbox:s1:u1:failed", "session.failed", "orchestrator"],
    ]);
    // The PM tells the agent to try again; that turn fails too.
    expect(noticesOf(p, failedTurn("u2", "Request failed: 401 again"))).toEqual([
      ["session.failed:inbox:s1:u1:failed:2", "session.failed", "pm"],
      ["session.failed:orchestrator:inbox:s1:u1:failed:2", "session.failed", "orchestrator"],
    ]);
    // Still one item, counting both.
    const open = [...p.inbox.values()].filter((i) => i.status === "open");
    expect(open).toEqual([expect.objectContaining({ attempts: 2 })]);
  });
  // Failures raised through InboxService (auto-retry, the launcher, a closed item opening again)
  // are covered end to end, notices included, in `run-failed-notices.test.ts`.
});

describe("a failed run's item (#275)", () => {
  it("is updated in place when the session fails again", () => {
    const p = new MemoryProjection();
    p.addSession({ ...sampleSession, status: "starting", projectId: "p1" });
    const error = { code: "open_failed", message: TOO_OLD, kind: "setup" as const };
    // The first start, then a Retry: the runner refuses to open the session both times.
    p.applyProcess({ kind: "session.process", sessionId: "s1", state: "crashed", error }, 3);
    p.applyProcess(
      {
        kind: "session.process",
        sessionId: "s1",
        state: "crashed",
        error: { ...error, message: "Gemini CLI 0.36.0 is still too old" },
      },
      9,
    );
    const open = [...p.inbox.values()].filter(
      (i) => i.kind === "run_failed" && i.sessionId === "s1" && i.status === "open",
    );
    expect(open).toEqual([
      expect.objectContaining({
        id: "inbox:s1:process:3",
        attempts: 2,
        body: "Gemini CLI 0.36.0 is still too old",
      }),
    ]);
  });
});
