import { randomUUID } from "node:crypto";
import type { FactoryItem, Session, UserInput } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { factoryReportReproduction, factorySubmitAnalysis } from "../src/mcp/tools/factory/builder";
import { RunnerCommandError } from "../src/runner/client";
import type { AppServices } from "../src/services/container";
import { BUILDER_RESUME } from "../src/services/factory/prompts";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { BUILDER_FAILED_REASON } from "../src/services/factory/turn-race";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #96: factory builders that a message racing their turn marked failed ("A turn is already
 * running") carry on instead of failing their item, and items failed that way go back to
 * building, within the agent limit.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const resumes = () => env.messages.filter((m) => m.text === BUILDER_RESUME);
const RACE = "A turn is already running";

/** A software factory (auto-merge on) with the given agent limit. */
function factory(maxConcurrentSessions = 3): void {
  env = createFactoryEnv({ limits: { maxConcurrentSessions } });
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
  } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
}

/** What a lost delivery race did to a builder: the session service failed it. */
async function raceFails(sessionId: string): Promise<void> {
  await env.setStatus(sessionId, "failed");
  env.inbox.raiseRunFailed(env.repo.get(sessionId), `send-${randomUUID()}`, RACE);
}

/** A factory session holding an agent (or, once it ends, giving it back). */
function factorySession(status: Session["status"], extra: Partial<Session> = {}): string {
  const id = randomUUID();
  env.repo.create(
    {
      ...sampleSession,
      id,
      projectId: env.project.id,
      startedBy: FACTORY_STARTER,
      workKey: `factory:test:${id.slice(0, 8)}`,
      scope: { projectId: env.project.id },
      status,
      ...extra,
    },
    { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
  );
  return id;
}

const feature = (n: number) => ({
  projectId: env.project.id,
  workKey: `issue:${n}`,
  title: `Feature ${n}`,
  summary: "Users want it",
  source: "discovery" as const,
  type: "feature" as const,
  investigation: {
    kind: "analysis" as const,
    outcome: "implement" as const,
    summary: "Missing",
    details: null,
    testPath: null,
    at: new Date().toISOString(),
  },
  score: 0.5,
  acceptanceCriteria: ["It works"],
  issue: { number: n, url: `https://github.com/acme/app/issues/${n}`, title: `Feature ${n}` },
});

/** An item whose builder the factory has started. */
async function building(n = 91): Promise<{ id: string; builderId: string }> {
  const created = env.factory.data.createItem({ ...feature(n), stage: "backlog" });
  await tick();
  expect(item(created.id).stage).toBe("building");
  return { id: created.id, builderId: item(created.id).builderSessionId as string };
}

/**
 * An item the factory failed before the fix: its builder lost a message race and the item
 * failed. Its builder was then archived (`stopped`), or is still `failed`.
 */
async function failedBeforeTheFix(
  n: number,
  builder: "stopped" | "failed" = "stopped",
): Promise<{ id: string; builderId: string }> {
  const at = new Date().toISOString();
  const builderId = factorySession("failed");
  env.inbox.raiseRunFailed(env.repo.get(builderId), `send-${n}`, RACE);
  if (builder === "stopped") {
    env.repo.update(builderId, (s) => ({ ...s, status: "stopped", archivedAt: at }));
  }
  const created = env.factory.data.createItem({
    ...feature(n),
    stage: "failed",
    builderSessionId: builderId,
    reason: BUILDER_FAILED_REASON,
  });
  env.factory.data.updateItem(created.id, (i) => ({
    ...i,
    finishedAt: at,
    sessionsArchivedAt: at,
  }));
  // Distinct creation times keep the oldest-first order deterministic.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { id: created.id, builderId };
}

const activeAgents = async () => (await env.factory.status(env.project.id)).activeSessions;

/**
 * The real session service (its queue, delivery and errors) behind the factory, over a runner
 * that can be away. A session the runner hosts takes a message as a turn; one it doesn't (an
 * archived builder) is opened again through the launcher, as `session.start` does.
 */
function realDelivery() {
  const runner = {
    up: false,
    hosted: new Set<string>(),
    /** Sessions whose turn the runner started, in order. */
    turns: [] as string[],
    /** An error code the runner answers every send and resume with (a session it can't start). */
    refuse: null as string | null,
    /**
     * Runs inside `session.start` / `session.send`, before the runner answers: where the
     * provider opens, lists CodeDen's MCP tools and the agent's turn begins.
     */
    opening: async (_sessionId: string): Promise<void> => {},
  };
  const away = () => new RunnerCommandError("runner_unavailable", "Runner is not connected");
  const port = {
    isConnected: () => runner.up,
    providers: () => [],
    request: async (command: { name: string; sessionId?: string }) => {
      if (!runner.up) throw away();
      if (command.name !== "session.send") return {};
      if (runner.refuse) throw new RunnerCommandError(runner.refuse, "The provider refused");
      const id = command.sessionId as string;
      if (!runner.hosted.has(id)) throw new RunnerCommandError("unknown_session", "Not hosted");
      await runner.opening(id);
      runner.turns.push(id);
      return {};
    },
  };
  const launcher = {
    resume: async (session: Session) => {
      if (!runner.up) throw away();
      if (runner.refuse) throw new RunnerCommandError(runner.refuse, "The provider refused");
      await runner.opening(session.id);
      runner.hosted.add(session.id);
      runner.turns.push(session.id);
    },
    fail: () => {},
  };
  const outbox = new Outbox(env.db.db, env.store);
  const service = new SessionService({
    repo: env.repo,
    runner: port,
    outbox,
    launcher,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
  } as unknown as SessionServiceDeps);
  env.sessions.send = service.send.bind(service);
  /** The runner is back: what `SessionRecovery` then does is deliver every waiting queue. */
  const reconnect = async () => {
    runner.up = true;
    service.releaseOutboxes();
    for (const id of service.sessionsWithQueuedMessages()) await service.flushOutbox(id);
  };
  const queued = (...ids: string[]) => ids.reduce((n, id) => n + outbox.count(id), 0);
  return { runner, reconnect, queued };
}

describe("factory builders hit by 'turn already running' (#96)", () => {
  it("does not fail the item when its builder failed with this error: the builder carries on", async () => {
    factory();
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
    factory();
    const { id, builderId } = await failedBeforeTheFix(91);

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

  it("leaves builders that failed for other reasons to the infrastructure recovery (#159)", async () => {
    factory();
    const { id, builderId } = await building();
    await env.setStatus(builderId, "failed");
    env.inbox.raiseRunFailed(env.repo.get(builderId), "start", "Could not open the session");
    await tick();
    expect(item(id)).toMatchObject({
      stage: "failed",
      reason: BUILDER_FAILED_REASON,
      failureKind: "infrastructure",
    });
    // Not told it lost a race: the general recovery resumes it with its own brief.
    await tick();
    expect(item(id).stage).toBe("building");
    expect(resumes()).toEqual([]);
    expect(env.messages.at(-1)).toMatchObject({
      sessionId: builderId,
      text: expect.stringMatching(/^\*\*Continue\*\*/),
    });
  });

  it("recovers failed items only as agents free up, oldest first", async () => {
    factory(1);
    const busy = factorySession("running");
    const a = await failedBeforeTheFix(91);
    const b = await failedBeforeTheFix(89);

    // The only agent is taken: both stay failed, still recoverable.
    await tick();
    expect(resumes()).toEqual([]);
    expect(item(a.id)).toMatchObject({ stage: "failed", note: expect.stringMatching(/agent/) });
    expect(item(b.id).stage).toBe("failed");
    expect(env.factory.data.item(a.id)?.reason).toBe(BUILDER_FAILED_REASON);

    // The agent frees up: the older item's builder takes it; the other keeps waiting.
    await env.setStatus(busy, "idle");
    await tick();
    expect(resumes()).toEqual([{ sessionId: a.builderId, text: BUILDER_RESUME }]);
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id).stage).toBe("failed");
    await tick();
    expect(resumes()).toHaveLength(1);

    // A second agent is allowed: the waiting item's builder carries on too.
    env.updateProject({
      factoryLimits: { ...env.project.factoryLimits, maxConcurrentSessions: 2 },
    });
    await tick();
    expect(resumes().map((m) => m.sessionId)).toEqual([a.builderId, b.builderId]);
    expect(item(b.id).stage).toBe("building");
  });

  it("waits for a free agent before telling a live builder to carry on", async () => {
    factory(1);
    const { id, builderId } = await building();
    await raceFails(builderId);
    const busy = factorySession("running");

    await tick();
    expect(resumes()).toEqual([]);
    expect(item(id)).toMatchObject({ stage: "building", note: expect.stringMatching(/agent/) });
    expect(env.repo.get(builderId).status).toBe("failed");

    await env.setStatus(busy, "idle");
    await tick();
    expect(resumes()).toEqual([{ sessionId: builderId, text: BUILDER_RESUME }]);
    expect(item(id).stage).toBe("building");
  });
});

describe("telling a builder to carry on, through the real session service (#96)", () => {
  it("recovers only once the turn starts: nothing queued while the runner is away, and the limit holds after", async () => {
    factory(1);
    const { runner, reconnect, queued } = realDelivery();
    const a = await failedBeforeTheFix(91, "failed");
    const b = await failedBeforeTheFix(89, "stopped");
    runner.hosted.add(a.builderId);

    // The runner is away: no turn starts and none waits in a queue to start later. Both
    // items stay failed and recoverable; the builders are as they were.
    await tick();
    expect(runner.turns).toEqual([]);
    expect(queued(a.builderId, b.builderId)).toBe(0);
    expect(item(a.id)).toMatchObject({
      stage: "failed",
      reason: BUILDER_FAILED_REASON,
      note: expect.stringMatching(/again next tick/),
    });
    expect(item(b.id).stage).toBe("failed");
    expect(env.repo.get(a.builderId).status).toBe("failed");
    expect(env.repo.get(b.builderId)).toMatchObject({ status: "stopped" });
    expect(await activeAgents()).toBe(0);

    // The runner is back: there is nothing queued for it to start past the limit.
    await reconnect();
    expect(runner.turns).toEqual([]);

    // The next tick admits the oldest; the other waits for an agent.
    await tick();
    expect(runner.turns).toEqual([a.builderId]);
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id)).toMatchObject({ stage: "failed", note: expect.stringMatching(/free/) });
    expect(await activeAgents()).toBe(1);
    await tick();
    expect(runner.turns).toEqual([a.builderId]);

    // A second agent: the archived builder is opened again and carries on.
    env.updateProject({
      factoryLimits: { ...env.project.factoryLimits, maxConcurrentSessions: 2 },
    });
    await tick();
    expect(runner.turns).toEqual([a.builderId, b.builderId]);
    expect(item(b.id).stage).toBe("building");
    expect(env.repo.get(b.builderId)).toMatchObject({ status: "running", archivedAt: null });
    expect(await activeAgents()).toBe(2);
    expect(queued(a.builderId, b.builderId)).toBe(0);
  });

  it("tells a live builder again on a later tick when the runner was away", async () => {
    factory(1);
    const { id, builderId } = await building();
    const { runner, reconnect, queued } = realDelivery();
    runner.hosted.add(builderId);
    await raceFails(builderId);

    await tick();
    expect(runner.turns).toEqual([]);
    expect(queued(builderId)).toBe(0);
    expect(item(id)).toMatchObject({ stage: "building", note: expect.stringMatching(/again/) });
    expect(env.repo.get(builderId).status).toBe("failed");

    await reconnect();
    await tick();
    expect(runner.turns).toEqual([builderId]);
    expect(env.repo.get(builderId).status).toBe("running");
    await tick();
    expect(runner.turns).toEqual([builderId]);
  });

  it("fails the item once when its builder can't be started at all, then leaves it to the infrastructure recovery", async () => {
    factory(1);
    const { id, builderId } = await building();
    const { runner } = realDelivery();
    runner.up = true;
    runner.hosted.add(builderId);
    runner.refuse = "provider_error";
    await raceFails(builderId);

    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", reason: BUILDER_FAILED_REASON });
    // While the builder still can't start, each attempt uses up one of its three recoveries.
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", nudges: { infra_1: expect.any(String) } });
    expect(runner.turns).toEqual([]);
    // Once it can, it goes back to building (#159), without another "carry on".
    runner.refuse = null;
    await tick();
    expect(item(id).stage).toBe("building");
    expect(runner.turns).toEqual([builderId]);
    expect(resumes()).toEqual([]);
  });
});

describe("a recovered builder's factory tools (#96)", () => {
  /** CodeDen's builder tools behind the real availability checks, as the MCP server lists them. */
  function builderTools() {
    const registry = new ToolRegistry([factoryReportReproduction, factorySubmitAnalysis], {
      factory: env.factory,
      sessionRepo: env.repo,
    } as unknown as AppServices);
    const caller = (sessionId: string) => ({ projectId: env.project.id, sessionId });
    return {
      list: (sessionId: string) => registry.list("agent", caller(sessionId)).map((t) => t.name),
      call: (sessionId: string, name: string, args: unknown) =>
        registry.call(name, args, {
          ...caller(sessionId),
          role: "agent",
          caller: "mcp",
          signal: new AbortController().signal,
        }),
    };
  }
  const ANALYSIS = {
    decision: "implement",
    summary: "Search the transcript",
    spec: "A search box over the session's items",
    acceptanceCriteria: ["Search finds a message"],
  };

  it("offers them while the builder starts, before the runner answers, for its first report", async () => {
    factory(1);
    const { runner } = realDelivery();
    runner.up = true;
    // Recovered before it reported its first step (the analysis).
    const recovered = await failedBeforeTheFix(91, "stopped");
    env.factory.data.updateItem(recovered.id, (i) => ({ ...i, investigation: null }));
    // A failed builder that isn't being recovered gets none.
    const other = await failedBeforeTheFix(89, "stopped");
    env.inbox.raiseRunFailed(env.repo.get(other.builderId), "start", "Could not open");
    const tools = builderTools();
    const listed: Record<string, string[]> = {};
    let report: Awaited<ReturnType<typeof tools.call>> | undefined;
    runner.opening = async (sessionId) => {
      listed[sessionId] = tools.list(sessionId);
      listed[other.builderId] = tools.list(other.builderId);
      report = await tools.call(sessionId, "factory_submit_analysis", ANALYSIS);
    };

    await tick();
    expect(runner.turns).toEqual([recovered.builderId]);
    expect(listed).toEqual({
      [recovered.builderId]: ["factory_report_reproduction", "factory_submit_analysis"],
      [other.builderId]: [],
    });
    expect(report).toMatchObject({ isError: false });
    expect(item(recovered.id)).toMatchObject({
      stage: "building",
      investigation: { kind: "analysis", outcome: "implement" },
    });
    expect(item(other.id).stage).toBe("failed");
  });

  it("puts the item back exactly as it was, without the tools, when the builder doesn't start", async () => {
    factory(1);
    const { runner } = realDelivery();
    runner.up = true;
    const recovered = await failedBeforeTheFix(91, "stopped");
    const before = item(recovered.id);
    const tools = builderTools();
    let listedWhileStarting: string[] = [];
    runner.opening = async (sessionId) => {
      listedWhileStarting = tools.list(sessionId);
      throw new RunnerCommandError("timeout", "The runner did not answer in time");
    };

    await tick();
    expect(listedWhileStarting).toEqual(["factory_report_reproduction", "factory_submit_analysis"]);
    expect(item(recovered.id)).toMatchObject({
      stage: "failed",
      reason: before.reason,
      finishedAt: before.finishedAt,
      sessionsArchivedAt: before.sessionsArchivedAt,
      nudges: before.nudges,
      updatedAt: before.updatedAt,
    });
    expect(tools.list(recovered.builderId)).toEqual([]);

    // The next tick tries again and it starts.
    runner.opening = async () => {};
    await tick();
    expect(runner.turns).toEqual([recovered.builderId]);
    expect(item(recovered.id).stage).toBe("building");
    expect(tools.list(recovered.builderId)).toEqual([
      "factory_report_reproduction",
      "factory_submit_analysis",
    ]);
  });

  it("finishes a recovery the server stopped in the middle of, instead of failing the item", async () => {
    factory(1);
    const { runner } = realDelivery();
    runner.up = true;
    const recovered = await failedBeforeTheFix(91, "stopped");
    // A factory session's failure is recorded settled: the factory handles it (#275).
    const [failure] = env.inbox.list({ sessionId: recovered.builderId, status: "resolved" });
    // What a server stopped while the builder was starting leaves: the item back in building
    // with the recovery marked as under way, the builder still stopped.
    env.factory.data.updateItem(recovered.id, (i) => ({
      ...i,
      stage: "building",
      reason: null,
      finishedAt: null,
      sessionsArchivedAt: null,
      nudges: { ...i.nudges, [`turn_race_recovering:${failure?.id}`]: new Date().toISOString() },
    }));

    await tick();
    expect(runner.turns).toEqual([recovered.builderId]);
    expect(item(recovered.id).stage).toBe("building");
    expect(env.repo.get(recovered.builderId).status).toBe("running");
  });
});
