import type { DiscoveryArea, FactoryLoop, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { scoutDue } from "../src/services/factory/scout";
import { pickLenses } from "../src/services/factory/scout-reports";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined) => env.repo.get(id as string);
const finding = (title: string) => ({
  title,
  summary: `${title}, which hurts users`,
  type: "bug" as const,
  severity: "medium" as const,
  acceptanceCriteria: [`${title} is fixed`],
});
const code = async (run: () => Promise<unknown>) =>
  run().then(
    () => "ok",
    (error: ServiceError) => error.code,
  );

function darkFactory(maxConcurrentSessions = 3) {
  env = createFactoryEnv({ limits: { maxConcurrentSessions } });
  env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions },
    tuning: { discoveryPerRound: 2, maxIssuesPerRound: 1 },
  });
}

/** A factory builder at work on issue #n: it holds an agent slot. */
function runningBuilder(n: number) {
  env.repo.create(
    {
      ...sampleSession,
      id: `builder-${n}`,
      projectId: env.project.id,
      startedBy: FACTORY_STARTER,
      workKey: `issue:${n}`,
      status: "running",
    },
    { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
  );
}

describe("the dark factory's scout (§10.1)", () => {
  it("plans within the lens limit, collects findings and files within the round limit", async () => {
    darkFactory();
    await tick();
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout"]);
    expect(loop().scout.round?.phase).toBe("planning");
    const scout = session(loop().scout.sessionId);

    const plan = await env.factory.planRound(scout, {
      lenses: [
        { area: "ux", focus: "the task editor" },
        { area: "security", focus: "the import endpoint" },
        { area: "performance", focus: "the list view" },
      ],
    });
    // Two per round, however many the scout asks for.
    expect(plan.lenses.map((l) => l.area)).toEqual(["ux", "security"]);
    expect(env.starts.map((s) => s.workKey)).toEqual([
      "factory:scout",
      "factory:lens:ux",
      "factory:lens:security",
    ]);
    expect(
      await code(() =>
        env.factory.fileIssue(scout, { ...finding("Early"), summary: "x", priority: "normal" }),
      ),
    ).toBe("lenses_reviewing");

    const [ux, security] = plan.lenses.map((l) => session(l.sessionId)) as [Session, Session];
    const reported = await env.factory.reportFindings(ux, [
      finding("Editor loses focus"),
      finding("Editor loses focus"),
    ]);
    expect(reported).toMatchObject({ recorded: 1, skipped: ["Editor loses focus"] });
    // The security lens ends its turn without reporting: reminded once, then counted as done.
    await env.setStatus(security.id, "idle");
    await tick();
    expect(env.messages.at(-1)).toMatchObject({ sessionId: security.id });
    await env.setStatus(security.id, "idle");
    await tick();
    expect(loop().scout.round?.phase).toBe("filing");
    expect(env.messages.at(-1)?.sessionId).toBe(scout.id);
    expect(env.messages.at(-1)?.text).toContain("[ux-1]");

    const filed = await env.factory.fileIssue(scout, {
      title: "Editor loses focus",
      summary: "Typing in the editor loses focus after a save.",
      type: "bug",
      acceptanceCriteria: ["Focus stays after a save"],
      priority: "high",
      findingIds: ["ux-1"],
    });
    const item = env.factory.data.item(filed.itemId);
    expect(item).toMatchObject({
      stage: "backlog",
      type: "bug",
      trust: "trusted",
      area: "ux",
      score: 0.9,
    });
    expect(item?.classification?.by).toBe("scout");
    expect(env.gh.issues.at(-1)?.labels).toEqual(["codeden-factory", "factory:bug"]);
    expect(
      await code(() =>
        env.factory.fileIssue(scout, { ...finding("Second"), summary: "y", priority: "low" }),
      ),
    ).toBe("round_limit");

    await env.setStatus(scout.id, "idle");
    await tick();
    expect(loop().scout).toMatchObject({ round: null, rounds: 1 });
    expect(loop().scout.lastRoundAt).not.toBeNull();
    // The filed issue went to a free agent.
    expect(env.factory.data.item(filed.itemId)?.stage).toBe("building");
  });

  it("wakes the same long-lived scout and lenses next round instead of starting new ones", async () => {
    darkFactory();
    await tick();
    const scout = session(loop().scout.sessionId);
    const first = await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
    const lens = session(first.lenses[0]?.sessionId);
    await env.factory.reportFindings(lens, []);
    await tick();
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(loop().scout.round).toBeNull();
    const starts = env.starts.length;

    env.clock.offsetMs = 7 * 3_600_000;
    await tick();
    expect(env.starts).toHaveLength(starts);
    expect(env.messages.at(-1)).toMatchObject({ sessionId: scout.id });
    expect(env.messages.at(-1)?.text).toMatch(/Round 2/);
    const second = await env.factory.planRound(scout, {
      lenses: [{ area: "ux", focus: "tables" }],
    });
    expect(second.lenses[0]?.sessionId).toBe(lens.id);
    expect(env.starts).toHaveLength(starts);
    expect(env.messages.at(-1)?.text).toMatch(/New round[\s\S]*tables/);
  });

  it("doesn't count the planning scout's own slot against its area reviewers", async () => {
    // Two agent slots, one builder at work: the round starts on the other slot.
    darkFactory(2);
    runningBuilder(1);
    await tick();
    expect(loop().scout.round?.phase).toBe("planning");
    const scout = session(loop().scout.sessionId);
    expect(scout.status).toBe("running");

    // The scout ends its turn right after planning, so its slot goes to a reviewer.
    const plan = await env.factory.planRound(scout, {
      lenses: [
        { area: "ux", focus: "the task editor" },
        { area: "security", focus: "the import endpoint" },
      ],
    });
    expect(plan.lenses.map((l) => l.area)).toEqual(["ux"]);
    expect(loop().scout.round?.phase).toBe("reviewing");
    expect(plan.next).toContain("`security`: no free agent slot (Agents at once is 2;");
    expect(plan.next).toContain("Raising Agents at once");
  });

  it("lets the scout review by itself when no agent slot is free", async () => {
    darkFactory(2);
    runningBuilder(1);
    await tick();
    const scout = session(loop().scout.sessionId);
    // Another factory session took the last slot while the scout was planning.
    runningBuilder(2);
    const plan = await env.factory.planRound(scout, {
      lenses: [{ area: "ux", focus: "forms" }],
    });
    expect(plan.lenses).toEqual([]);
    expect(loop().scout.round?.phase).toBe("filing");
    expect(plan.next).toMatch(/^No area reviewers this round\./);
    expect(plan.next).toContain("other factory sessions hold 2)");
    expect(plan.next).toContain("Review by yourself now");
  });

  it("says why each review area the scout asked for got no area reviewer", () => {
    const ask = (...areas: DiscoveryArea[]) => areas.map((area) => ({ area, focus: "x" }));
    const { picked, dropped } = pickLenses(
      ask("ux", "docs", "ux", "security", "performance", "bugs"),
      { areas: ["ux", "security", "performance", "bugs"], perRound: 3, slots: 1 },
    );
    expect(picked.map((l) => l.area)).toEqual(["ux"]);
    expect(dropped).toEqual({
      not_allowed: ["docs"],
      duplicate: ["ux"],
      no_slot: ["security", "performance"],
      round_limit: ["bugs"],
      failed: [],
    });
  });

  it("starts a round only when the queue runs low and the interval has passed", () => {
    const base = {
      scout: { round: null, lastRoundAt: null },
      tuning: { minBacklog: 2, discoveryIntervalMin: 60 },
    } as unknown as FactoryLoop;
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(scoutDue(base, 0, now)).toBe(true);
    expect(scoutDue(base, 2, now)).toBe(false);
    const recent = { ...base, scout: { round: null, lastRoundAt: "2026-11-11T11:30:00Z" } };
    expect(scoutDue(recent as FactoryLoop, 0, now)).toBe(false);
    const old = { ...base, scout: { round: null, lastRoundAt: "2026-11-11T10:30:00Z" } };
    expect(scoutDue(old as FactoryLoop, 0, now)).toBe(true);
    // A threshold of 0 turns scheduled rounds off, even with an empty queue.
    const off = { ...base, tuning: { minBacklog: 0, discoveryIntervalMin: 60 } } as FactoryLoop;
    expect(scoutDue(off, 0, now)).toBe(false);
  });

  it("keeps its tools to the scout and its lenses", async () => {
    darkFactory();
    await tick();
    const stranger = { ...session(loop().scout.sessionId), id: "not-the-scout" };
    expect(await code(() => env.factory.planRound(stranger, { lenses: [] }))).toBe("not_the_scout");
    expect(await code(() => env.factory.reportFindings(stranger, []))).toBe("no_round");
  });
});
