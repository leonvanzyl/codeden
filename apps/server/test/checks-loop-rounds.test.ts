import { agentEventToNewEvent } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTART_CONTINUE_MESSAGE } from "../src/services/sessions/recovery";
import {
  CHECKS,
  type ChecksEnv,
  createChecksEnv,
  fail,
  pass,
  T,
  until,
  usageLimit,
  user,
  wait,
} from "./support/checks-env";

/**
 * The checks loop's round count (#412): only a new user message (or switching the loop off and
 * on) starts it again. Turns CodeDen starts itself (Compact now, auto-retry's and recovery's
 * "continue") never do, so the loop can't run past its cap unattended.
 */

let c: ChecksEnv;

beforeEach(() => {
  c = createChecksEnv();
  c.script.set("pnpm test", [fail("still broken")]);
});

afterEach(async () => {
  await c.close();
});

const rounds = () => c.sends().flatMap((s) => (s.checksRound ? [s.checksRound] : []));

/** A session whose checks keep failing, run until the loop stops at its cap of 2 rounds. */
async function atTheCap(): Promise<string> {
  const id = c.newSession({ ...CHECKS, maxRounds: 2 });
  c.turn(id, user("Add the feature"));
  await until(() => c.turnCount() === 3 && c.card(id, "u3")?.item.status === "completed");
  expect(c.card(id, "u3")?.data.outcome).toBe("cap_reached");
  expect(rounds()).toEqual([1, 2]);
  expect(c.env.repo.get(id).checks).toMatchObject({ round: 2, capReached: true });
  return id;
}

function atTheCapThenPassAfterRetry(): Promise<string> {
  // Three failures reach the cap. After the reset, fail once and pass on the retry.
  const failure = fail("still broken");
  c.script.set("pnpm test", [failure, failure, failure, failure, pass()]);
  return atTheCap();
}

/** Let a turn that just started run its course, and whatever the loop does after it. */
async function settle(turns: number): Promise<void> {
  await until(() => c.turnCount() >= turns);
  await wait(100);
}

describe("the checks loop's round count (#412)", () => {
  it("starts no new round after a Compact now turn at the cap", async () => {
    const id = await atTheCap();
    expect(await c.sessions.compact(id)).toEqual({ status: "compacting" });
    await settle(4);
    expect(rounds()).toEqual([1, 2]);
    expect(c.env.repo.get(id).status).toBe("idle");
  });

  it("starts no new round after a restart's continue at the cap", async () => {
    const id = await atTheCap();
    await c.sessions.continueAfterRestart(id, RESTART_CONTINUE_MESSAGE);
    await settle(4);
    expect(rounds()).toEqual([1, 2]);
  });

  it("keeps counting through a usage limit and auto-retry's continue", async () => {
    const id = c.newSession();
    // The agent's fix turn for round 1 hits a usage limit; auto-retry continues it.
    c.turnEnds.push(usageLimit());
    c.turn(id, user("Add the feature"));
    await until(() => c.sends().length >= 3);
    const [round1, resume, next] = c.sends();
    expect(round1?.checksRound).toBe(1);
    expect(resume).toMatchObject({ from: "codeden" });
    expect(resume?.text).toContain("usage limit reached");
    expect(resume?.checksRound).toBeUndefined();
    // The checks after the continued turn are still round 1's, so the next message is round 2.
    expect(c.card(id, "u3")?.data.round).toBe(1);
    expect(next?.checksRound).toBe(2);
  });

  it("starts the count again on a new user message", async () => {
    const id = await atTheCapThenPassAfterRetry();
    await c.sessions.send(id, { input: user("Try another way"), whenBusy: "queue" });
    expect(c.env.repo.get(id).checks?.capReached).toBeUndefined();
    await until(() => c.card(id, "u5")?.data.outcome === "passed");
    expect(c.card(id, "u4")?.data.round).toBe(0);
    expect(rounds()).toEqual([1, 2, 1]);
  });

  it("starts the count again when the user switches the loop off and on", async () => {
    const id = await atTheCapThenPassAfterRetry();
    await c.sessions.update(id, { untilChecksPass: false });
    await c.sessions.update(id, { untilChecksPass: true });
    expect(c.env.repo.get(id).checks?.round).toBeUndefined();
    // A turn CodeDen starts itself (not a compaction, which runs no checks) runs them again.
    await c.sessions.continueAfterRestart(id, RESTART_CONTINUE_MESSAGE);
    await until(() => c.card(id, "u5")?.data.outcome === "passed");
    expect(c.card(id, "u4")?.data.round).toBe(0);
    expect(rounds()).toEqual([1, 2, 1]);
  });

  it("refuses Compact now while checks run, and keeps their run", async () => {
    c.script.set("pnpm typecheck", ["hang"]);
    const id = c.newSession();
    const first = c.turn(id, user("Add the feature"));
    await until(c.hanging);
    await expect(c.sessions.compact(id)).rejects.toMatchObject({
      status: 409,
      code: "checks_running",
    });
    expect(c.calls.map((r) => r.name)).not.toContain("session.compact");
    expect(c.loop.isRunning(id)).toBe(true);
    expect(c.card(id, first)?.item.status).toBe("in_progress");
  });
});

describe("after a server crash (#412)", () => {
  it("cancels the check a crash left running on the runner", async () => {
    const id = c.newSession({ ...CHECKS, untilPass: false });
    const t = c.turn(id, user("x"));
    c.env.store.append([
      agentEventToNewEvent(id, {
        type: "item.updated",
        threadId: T,
        turnId: t,
        item: {
          id: `checks-${t}`,
          kind: "notice",
          status: "in_progress",
          level: "info",
          code: "check_run",
          message: "Running",
          data: {
            round: 0,
            maxRounds: 3,
            checks: [{ command: "pnpm test", status: "running", exitCode: null }],
          },
        },
      }),
    ]);
    c.loop.stop();
    c.loop.start();
    expect(c.card(id, t)?.data.outcome).toBe("interrupted");
    await until(() => c.calls.some((r) => r.name === "check.cancel" && r.sessionId === id));
  });
});
