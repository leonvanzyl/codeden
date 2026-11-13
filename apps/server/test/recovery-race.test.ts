import type { Session } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RunnerPort, RunnerRouter } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRecovery } from "../src/services/sessions/recovery";
import type { SessionRepo } from "../src/services/sessions/repo";
import type { SessionService } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

/**
 * Recovery after a runner connects, with a session started on that runner while its
 * `runner.status` request is in flight (the CI flake in restart-recovery.test.ts): the new
 * session turns `running` before the reply is handled, and the reply does not list it.
 */
describe("session recovery", () => {
  function setup(initial: Session[], runners?: (home: RunnerPort) => RunnerRouter) {
    const sessions = new Map(initial.map((s) => [s.id, s]));
    const repo = {
      list: ({ status }: { status?: string[] }) =>
        [...sessions.values()].filter((s) => !status || status.includes(s.status)),
      find: (id: string) => {
        const session = sessions.get(id);
        return session ? { session } : undefined;
      },
      closeOrphanedTurns: vi.fn(() => 0),
    } as unknown as SessionRepo;
    const continueAfterRestart = vi.fn(async () => undefined);
    const service = {
      launching: new Map<string, Promise<void>>(),
      continueAfterRestart,
      sessionsWithQueuedMessages: () => [],
      releaseOutboxes: () => undefined,
    } as unknown as SessionService;
    const fail = vi.fn();
    const launcher = { fail } as unknown as SessionLauncher;
    let onStatus: () => void = () => undefined;
    const runner = {
      request: vi.fn(async () => {
        onStatus();
        return { sessions: [], ptys: [], journal: { lastSeq: 0, unacked: 0 }, draining: false };
      }),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const recovery = new SessionRecovery({
      repo,
      sessions: service,
      launcher,
      runner,
      runners: runners?.(runner),
    });
    return {
      recovery,
      repo,
      sessions,
      continueAfterRestart,
      fail,
      whileStatusInFlight: (fn: () => void) => {
        onStatus = fn;
      },
    };
  }

  it("leaves alone a session that started while runner.status was in flight", async () => {
    const t = setup([{ ...sampleSession, id: "new", status: "starting", provider: "fake" }]);
    t.whileStatusInFlight(() => {
      const s = t.sessions.get("new");
      if (s) t.sessions.set("new", { ...s, status: "running" });
    });
    await t.recovery.onRunnerReady();
    expect(t.fail).not.toHaveBeenCalled();
    expect(t.continueAfterRestart).not.toHaveBeenCalled();
    expect(t.sessions.get("new")?.status).toBe("running");
  });

  it("only resumes the cut-off sessions of the runner that became ready", async () => {
    const other = {
      request: vi.fn(async () => ({
        sessions: [],
        ptys: [],
        journal: { lastSeq: 0, unacked: 0 },
        draining: false,
      })),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const cut = {
      ...sampleSession,
      status: "running",
      provider: "fake",
      resumeToken: "r",
    } as const;
    const t = setup(
      [
        { ...cut, id: "at-home" },
        { ...cut, id: "on-b", runnerId: "r-b" },
      ],
      (home) => ({
        home: () => home,
        forSession: (id) => (id === "on-b" ? other : home),
        forRunnerId: (runnerId) => (runnerId === "r-b" ? other : home),
      }),
    );
    await t.recovery.onRunnerReady("r-b");
    expect(other.request).toHaveBeenCalledWith({ name: "runner.status" }, 10_000);
    expect(t.continueAfterRestart.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["on-b"]);
    await t.recovery.onRunnerReady("r-home");
    expect(t.continueAfterRestart.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "on-b",
      "at-home",
    ]);
  });

  it("still resumes a session whose turn was cut off before the runner was ready", async () => {
    const t = setup([
      { ...sampleSession, id: "cut", status: "running", provider: "fake", resumeToken: "r1" },
    ]);
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart).toHaveBeenCalledWith("cut", expect.any(String));
    // Turns and approvals the dead runner left open are closed before resuming.
    expect(t.repo.closeOrphanedTurns).toHaveBeenCalledWith("cut");
    expect(t.fail).not.toHaveBeenCalled();
  });
});
