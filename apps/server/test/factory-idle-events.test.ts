import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #139: the events table is append-only and never pruned, and every `factory.loop.updated`
 * makes open factory panels refetch. A loop tick that changes nothing must append nothing: an
 * idle factory ticks every 30 s and on every factory session update.
 *
 * The clock is fake (`Date` only), so each tick happens at a later time, as in production.
 */

/** How often the factory loop ticks in production. */
const TICK_MS = 30_000;

let env: FactoryEnv;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
});
afterEach(() => {
  env?.close();
  vi.useRealTimers();
});

const enable = (mode: "software_factory" | "dark_factory" = "software_factory") =>
  env.factory.setMode(env.project.id, { mode, limits: env.project.factoryLimits });
const tick = () => env.factory.tick(env.project.id);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** Events appended after `seq`, by type. */
const eventsAfter = (seq: number) => env.store.listAfter(seq).map((e) => e.type);

/** Tick `n` more times, 30 s apart; the event types they appended. */
async function idleTicks(n: number): Promise<string[]> {
  const from = env.store.headSeq();
  for (let i = 0; i < n; i++) {
    advance(TICK_MS);
    await tick();
  }
  return eventsAfter(from);
}

describe("an idle factory loop (#139)", () => {
  it("appends no loop event on a software factory tick that changes nothing", async () => {
    env = createFactoryEnv();
    enable();
    await tick();
    expect(await idleTicks(5)).toEqual([]);
  });

  it("appends no loop event on a dark factory tick that changes nothing", async () => {
    env = createFactoryEnv();
    enable("dark_factory");
    await tick();
    expect(await idleTicks(5)).toEqual([]);
  });

  it("appends no loop event while a project that left factory mode keeps being ticked", async () => {
    env = createFactoryEnv();
    enable();
    await tick();
    env.factory.setMode(env.project.id, { mode: "assisted" });
    await tick();
    expect(await idleTicks(5)).toEqual([]);
  });

  it("shows the time of the last tick, also one that saved nothing", async () => {
    env = createFactoryEnv();
    enable();
    await tick();
    const saved = env.factory.data.loop(env.project.id)?.lastTickAt;
    advance(TICK_MS);
    await tick();
    expect(env.factory.data.loop(env.project.id)?.lastTickAt).toBe(saved);
    expect((await env.factory.status(env.project.id)).lastTickAt).toBe(new Date().toISOString());
    // After a restart, the last saved tick until the first tick runs.
    env.restart();
    expect((await env.factory.status(env.project.id)).lastTickAt).toBe(saved);
  });

  it("still saves the loop when a tick changes it", async () => {
    env = createFactoryEnv();
    enable();
    await tick();
    // The day rolls over: fresh counters.
    let from = env.store.headSeq();
    advance(24 * 60 * 60_000);
    const day = (await tick()).day;
    expect(eventsAfter(from)).toContain("factory.loop.updated");
    expect(env.factory.data.loop(env.project.id)?.day).toBe(day);
    // The kill switch stops the loop.
    from = env.store.headSeq();
    env.updateProject({ killSwitch: true });
    advance(TICK_MS);
    expect((await tick()).state).toBe("stopped");
    expect(eventsAfter(from)).toContain("factory.loop.updated");
    expect(env.factory.data.loop(env.project.id)?.state).toBe("stopped");
  });
});
