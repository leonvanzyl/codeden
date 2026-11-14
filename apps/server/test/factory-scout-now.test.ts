import { type FactoryLoop, FactoryTuning, type Project, ScoutState } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { type ScoutNowFacts, scoutNowBlocker } from "../src/services/factory/scout";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const failure = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (error: ServiceError) => ({ code: error.code, message: error.message }),
  );

/** A dark factory whose scout never runs on its own (`minBacklog` 0). */
function onDemandScout() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 2 } });
  return env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions: 2 },
    tuning: { minBacklog: 0, discoveryIntervalMin: 600, maxIssuesPerRound: 1 },
  });
}

describe("Run scout now (§10.1)", () => {
  it("says why a manual round can't start, in order", () => {
    const project = {
      autonomyMode: "dark_factory",
      archivedAt: null,
      killSwitch: false,
      factoryLimits: { maxConcurrentSessions: 2 },
    } as unknown as Project;
    const idle = { state: "idle", pausedReason: null, scout: ScoutState.parse({}) } as Pick<
      FactoryLoop,
      "state" | "pausedReason" | "scout"
    >;
    const facts: ScoutNowFacts = { globalKillSwitch: false, activeSessions: 1, overBudget: null };
    expect(scoutNowBlocker(project, idle, facts)).toBeNull();

    const blocked = (p: Partial<Project>, l: Partial<FactoryLoop>, f: Partial<ScoutNowFacts>) =>
      scoutNowBlocker({ ...project, ...p } as Project, { ...idle, ...l }, { ...facts, ...f });
    expect(blocked({ autonomyMode: "software_factory" }, {}, {})).toBe(
      "Only a dark factory has a scout.",
    );
    expect(blocked({ archivedAt: "2026-11-12T00:00:00Z" }, {}, {})).toBe(
      "The project is archived.",
    );
    expect(blocked({}, {}, { globalKillSwitch: true })).toBe("The global kill switch is on.");
    expect(blocked({ killSwitch: true }, {}, {})).toBe("The kill switch is on.");
    expect(blocked({}, { state: "paused", pausedReason: "3 failures in a row" }, {})).toBe(
      "The loop is paused: 3 failures in a row.",
    );
    expect(blocked({}, {}, { overBudget: "daily budget reached ($5.00 of $5.00)" })).toBe(
      "Daily budget reached ($5.00 of $5.00).",
    );
    const running = ScoutState.parse({
      round: {
        id: "r1",
        phase: "planning",
        startedAt: "2026-11-12T00:00:00Z",
        sentAt: "2026-11-12T00:00:00Z",
        nudgedAt: null,
        lenses: [],
        findings: [],
        filed: 0,
      },
    });
    expect(blocked({}, { scout: running }, {})).toBe("A scout round is already running.");
    expect(blocked({}, {}, { activeSessions: 2 })).toBe(
      "No free agent: all 2 are working (Agents at once).",
    );
    // The free agent goes to work waiting for one; at the WIP limit no round starts.
    expect(blocked({}, {}, { waitingForAgent: 1 })).toBe(
      "No free agent: reviews, fixes and builds waiting for one come first.",
    );
    const wip = { openPrs: 2, limit: 2, holding: true, waitingOnProvider: 0, note: null };
    expect(blocked({}, {}, { wip })).toBe(
      "Finishing open work (2 of 2 PRs open): the scout finds new work once open pull requests merge.",
    );
    // A paused loop is named before the agent limit.
    expect(blocked({}, { state: "paused", pausedReason: null }, { activeSessions: 2 })).toBe(
      "The loop is paused.",
    );
  });

  it("starts a round at once, ignoring the backlog threshold and the interval", async () => {
    await onDemandScout();
    // Scheduled rounds are off: an empty queue doesn't start the scout.
    await tick();
    expect(env.starts).toHaveLength(0);
    let status = await env.factory.status(env.project.id);
    expect(status.scout).toMatchObject({ phase: "idle", nextRoundAt: null, runNowBlockedBy: null });

    await env.factory.runScout(env.project.id);
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout"]);
    expect(loop().scout.round?.phase).toBe("planning");
    status = await env.factory.status(env.project.id);
    expect(status.loopState).toBe("discovering");
    expect(status.scout?.runNowBlockedBy).toBe("A scout round is already running.");
    expect(await failure(() => env.factory.runScout(env.project.id))).toEqual({
      code: "scout_unavailable",
      message: "A scout round is already running.",
    });

    // The round ends; the interval (10 hours) hasn't passed, and a manual round still starts.
    const scout = env.repo.get(loop().scout.sessionId as string);
    await env.factory.planRound(scout, { lenses: [] });
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(loop().scout).toMatchObject({ round: null, rounds: 1 });
    await env.factory.runScout(env.project.id);
    expect(loop().scout).toMatchObject({ rounds: 2, round: { phase: "planning" } });
    expect(env.messages.at(-1)).toMatchObject({ sessionId: scout.id });
    expect(env.messages.at(-1)?.text).toMatch(/Round 2/);
  });

  it("is refused while the kill switch is on", async () => {
    await onDemandScout();
    await env.factory.setKillSwitch(env.project.id, true);
    expect((await env.factory.status(env.project.id)).scout?.runNowBlockedBy).toBe(
      "The kill switch is on.",
    );
    expect(await failure(() => env.factory.runScout(env.project.id))).toMatchObject({
      code: "scout_unavailable",
    });
    expect(env.starts).toHaveLength(0);
  });

  it("saves one tuning knob without resetting the others", async () => {
    await onDemandScout();
    await env.factory.setMode(env.project.id, { mode: "dark_factory", tuning: { minBacklog: 4 } });
    expect(loop().tuning).toEqual({
      ...FactoryTuning.parse({}),
      minBacklog: 4,
      discoveryIntervalMin: 600,
      maxIssuesPerRound: 1,
    });
  });
});
