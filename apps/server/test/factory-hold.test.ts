import { FACTORY_HOLD_LABEL } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerToolContext } from "../src/mcp/define";
import { stopSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Held work (#593, §10.1): the hold label keeps an issue out of the factory loop, releasing it
 * lets the loop pick it up again, and a stop the PM makes with a reason is recorded as its call,
 * never as a failure towards the pause, while a builder's own failure still counts.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);
const projectId = () => env.project.id;
const byIssue = (number: number) =>
  env.factory.data.items(projectId()).find((i) => i.issue?.number === number);
const openIssue = (title: string, labels: string[] = []) =>
  env.gh.openIssue({ projectId: projectId(), title, author: "codeden", labels });
const loop = () => env.factory.data.loopOrNew(projectId());

/** The PM's `stop_session`, through the tool. */
function pmStop(sessionId: string, reason?: string) {
  const services = { factory: env.factory, sessions: env.sessions, sessionRepo: env.repo };
  const ctx = {
    services: services as unknown as AppServices,
    sessionId: null,
    projectId: projectId(),
    role: "pm",
    caller: "mcp",
    signal: new AbortController().signal,
  } as ServerToolContext<"project">;
  return stopSession.handler({ sessionId, reason }, ctx);
}

describe("holding issues out of the factory loop (#593)", () => {
  it("never takes a held issue in, and takes it in once released", async () => {
    env = createFactoryEnv();
    s.enable();
    const held = openIssue("Add CSV export");
    // Labelled on GitHub by a person: held too, with no reason recorded.
    const labelled = openIssue("Add JSON export", [FACTORY_HOLD_LABEL]);
    const res = await env.factory.hold(
      projectId(),
      { issueNumber: held.number, reason: "waiting on #11" },
      "pm",
    );
    expect(res).toMatchObject({ held: true, itemId: null, stage: null });
    expect(res.message).toMatch(/won't take #\d+ in until it is released/);
    expect(env.gh.issue(projectId(), held.number)?.labels).toContain(FACTORY_HOLD_LABEL);
    expect(env.gh.comments.at(-1)?.body).toMatch(/held out of the factory loop .*: waiting on #11/);

    await s.tick();
    expect(byIssue(held.number)).toBeUndefined();
    expect(byIssue(labelled.number)).toBeUndefined();
    expect(env.starts).toHaveLength(0);
    const status = await env.factory.status(projectId());
    expect(status.held).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ number: held.number }),
        itemId: null,
        reason: "waiting on #11",
        by: "pm",
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ number: labelled.number }),
        reason: null,
        by: null,
      }),
    ]);

    const released = await env.factory.release(
      projectId(),
      { issueNumber: held.number, reason: "#11 merged" },
      "pm",
    );
    expect(released).toMatchObject({ held: false });
    expect(env.gh.issue(projectId(), held.number)?.labels).not.toContain(FACTORY_HOLD_LABEL);
    expect(loop().holds).toEqual([]);
    await s.tick();
    expect(byIssue(held.number)?.stage).toBe("building");
    expect(byIssue(labelled.number)).toBeUndefined();

    // The label taken off on GitHub releases it just the same.
    await env.gh.unlabelIssue(projectId(), labelled.number, [FACTORY_HOLD_LABEL]);
    await s.tick();
    expect(byIssue(labelled.number)).toBeDefined();
    expect((await env.factory.status(projectId())).held).toEqual([]);
  });

  it("lists an issue the label holds that the loop never took in, and says how each one is held", async () => {
    env = createFactoryEnv();
    // Opened before the loop was switched on and without the intake label, so intake never takes
    // it in: all CodeDen knows about it is the label GitHub reports.
    const handHeld = openIssue("Retire the legacy exporter", [FACTORY_HOLD_LABEL]);
    env.clock.offsetMs = 2 * 60 * 60_000;
    s.enable();
    const pmHeld = openIssue("Add CSV export");
    await env.factory.hold(
      projectId(),
      { issueNumber: pmHeld.number, reason: "waiting on #11" },
      "pm",
    );
    await s.tick();

    // The admission gate skips the labelled issue either way: the view must list it too, or the
    // loop refuses work nobody can see.
    expect(byIssue(handHeld.number)).toBeUndefined();
    const held = (await env.factory.status(projectId())).held;
    expect(held.map((h) => h.issue.number)).toEqual([handHeld.number, pmHeld.number]);
    // A hold CodeDen recorded (a record plus the label) and one only the label makes.
    expect(held).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ number: handHeld.number }),
        itemId: null,
        kind: "label",
        reason: null,
        by: null,
        since: null,
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ number: pmHeld.number }),
        kind: "recorded",
        reason: "waiting on #11",
        by: "pm",
      }),
    ]);

    // The label taken off on GitHub: it is not held any more, and the loop still skips it because
    // it was opened before the factory was switched on.
    await env.gh.unlabelIssue(projectId(), handHeld.number, [FACTORY_HOLD_LABEL]);
    await s.tick();
    expect((await env.factory.status(projectId())).held.map((h) => h.issue.number)).toEqual([
      pmHeld.number,
    ]);
    expect(byIssue(handHeld.number)).toBeUndefined();
  });

  it("parks a queued item until it is released, and leaves work in progress alone", async () => {
    env = createFactoryEnv();
    s.enable();
    const a = openIssue("Add a counter");
    const b = openIssue("Add a timer");
    const queued = s.backlogItem("Add a counter", a.number);
    const running = s.backlogItem("Add a timer", b.number);
    const res = await env.factory.hold(projectId(), { issueNumber: a.number }, "pm");
    expect(res).toMatchObject({ itemId: queued.id, stage: "backlog" });
    expect(res.message).toMatch(/parked in the queue/);

    await s.tick();
    expect(s.item(queued.id).stage).toBe("backlog");
    expect(s.item(running.id).stage).toBe("building");
    expect(env.starts).toHaveLength(1);
    const status = await env.factory.status(projectId());
    expect(status.backlog.map((w) => w.id)).not.toContain(queued.id);
    expect(status.held).toEqual([expect.objectContaining({ itemId: queued.id, reason: null })]);

    // Held while it runs: it carries on, nothing is stopped.
    const inProgress = await env.factory.hold(projectId(), { issueNumber: b.number }, "pm");
    expect(inProgress.message).toMatch(/already in progress \(building\), so it carries on/);
    await s.tick();
    expect(s.item(running.id).stage).toBe("building");
    expect(env.stopped).toEqual([]);

    await env.factory.release(projectId(), { issueNumber: a.number }, "pm");
    await s.tick();
    expect(s.item(queued.id).stage).toBe("building");
  });
});

describe("stops the PM makes with a reason (#593)", () => {
  it("records them as stops, not failures, while a builder's failure still counts", async () => {
    // Paused after a single failure, so any stop counted as one would pause the loop.
    env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: 1 } });
    s.enable();

    // A builder stopped with a reason.
    const a = s.backlogItem("Add a counter", 21);
    await s.tick();
    const builder = s.item(a.id).builderSessionId as string;
    await pmStop(builder, "superseded by #9");
    expect(s.item(a.id).stop).toMatchObject({ sessionId: builder, reason: "superseded by #9" });
    await s.tick();
    expect(s.item(a.id)).toMatchObject({
      stage: "failed",
      reason: "Stopped by the PM: superseded by #9",
    });
    expect(loop()).toMatchObject({
      consecutiveFailures: 0,
      state: expect.not.stringMatching(/paused/),
    });
    // The PM made the call: it isn't told the item failed.
    expect(env.notices.some((n) => n.id === `factory.failed:${a.id}`)).toBe(false);

    // A reviewer stopped with a reason.
    const b = await s.verifying("success", "Add a timer", 22);
    await s.tick();
    const reviewer = s.item(b.id).reviewerSessionId as string;
    expect(reviewer).toBeTruthy();
    await pmStop(reviewer, "waiting on #8");
    await s.tick();
    expect(s.item(b.id)).toMatchObject({
      stage: "failed",
      reason: "Stopped by the PM: waiting on #8",
    });
    expect(loop().consecutiveFailures).toBe(0);

    // The builder's own failure: it ends without a pull request after its nudge.
    const c = s.backlogItem("Add a stopwatch", 23);
    await s.tick();
    const failing = s.item(c.id).builderSessionId as string;
    await env.setStatus(failing, "idle");
    await s.tick();
    await env.setStatus(failing, "idle");
    s.later(11 * 60_000);
    await s.tick();
    expect(s.item(c.id).stage).toBe("failed");
    expect(loop()).toMatchObject({ consecutiveFailures: 1, state: "paused" });

    // Retry clears the stop: the item runs again from the queue.
    env.factory.retry(projectId(), a.id, "rebuild", "pm");
    expect(s.item(a.id)).toMatchObject({ stage: "backlog", stop: null });
  });

  it("keeps a stop made while the tick steps through earlier items the PM's call", async () => {
    env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: 1 } });
    s.enable();
    const items = [s.backlogItem("Add a counter", 31), s.backlogItem("Add a timer", 32)];
    await s.tick();
    const builders = items.map((i) => s.item(i.id).builderSessionId as string);
    expect(builders.every(Boolean)).toBe(true);
    for (const id of builders) await env.setStatus(id, "idle");
    // The tick has read both building items; while it nudges the first, the PM stops the other's
    // builder, so the tick's copy of that item has no stop on it.
    const send = env.sessions.send;
    let other: string | undefined;
    env.sessions.send = (async (...args: Parameters<typeof send>) => {
      if (!other) {
        other = builders.find((id) => id !== args[0]);
        if (other) await pmStop(other, "waiting on #30");
      }
      return send(...args);
    }) as typeof send;
    await s.tick();
    const stopped = items.map((i) => s.item(i.id)).find((i) => i.builderSessionId === other);
    expect(stopped).toMatchObject({ stage: "failed", reason: "Stopped by the PM: waiting on #30" });
    expect(loop()).toMatchObject({
      consecutiveFailures: 0,
      state: expect.not.stringMatching(/paused/),
    });
  });
});
