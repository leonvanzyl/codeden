import { randomUUID } from "node:crypto";
import type { FactoryItem, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BUILDER_RESUME } from "../src/services/factory/prompts";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { BUILDER_FAILED_REASON } from "../src/services/factory/turn-race";
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
 * An item the factory failed before the fix: its builder lost a message race, the item failed
 * and the builder was archived.
 */
async function failedBeforeTheFix(n: number): Promise<{ id: string; builderId: string }> {
  const at = new Date().toISOString();
  const builderId = factorySession("failed");
  env.inbox.raiseRunFailed(env.repo.get(builderId), `send-${n}`, RACE);
  env.repo.update(builderId, (s) => ({ ...s, status: "stopped", archivedAt: at }));
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

  it("leaves items that failed for other reasons alone", async () => {
    factory();
    const { id, builderId } = await building();
    await env.setStatus(builderId, "failed");
    env.inbox.raiseRunFailed(env.repo.get(builderId), "start", "Could not open the session");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", reason: BUILDER_FAILED_REASON });
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(resumes()).toEqual([]);
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
