import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEDEN_CREDENTIAL_FILES,
  InboxItem,
  type ProviderInfo,
  type RunnerCommand,
  type Session,
  Settings,
  StartSessionRequest,
  type StartSessionRequestInit,
  StartSessionResponse,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { homePaths } from "../src/paths";
import type { RunnerPort } from "../src/services/runner-port";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { planModeUnsupported } from "../src/services/sessions/permissions";
import { applyPendingConfig, updateSession } from "../src/services/sessions/reconfigure";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const caps: ProviderInfo["capabilities"] = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: true,
  reasoningEffort: false,
  mcp: true,
  skills: false,
};

describe("plan mode through a real runner (Fake provider)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  const session = async (id: string) => (await h.detail(id)).session;
  const idle = (id: string) =>
    waitUntil(async () => ((await session(id)).status === "idle" ? true : undefined));
  /** The open approval of a session, once it shows up in the inbox. */
  const openApproval = (id: string) =>
    waitUntil(async () =>
      ((await h.api("GET", `/inbox?sessionId=${id}`)).body as unknown[])
        .map((i) => InboxItem.parse(i))
        .find((i) => i.kind === "approval" && i.status === "open"),
    );
  const answer = (id: string, requestId: string | null, decision: string, message?: string) =>
    h.api("POST", `/sessions/${id}/respond`, {
      requestId,
      response: { kind: "approval", decision, ...(message ? { message } : {}) },
    });

  it("starts planning, keeps planning when declined and implements once approved", {
    timeout: 60_000,
  }, async () => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      planMode: true,
      purpose: `Plan first ${Math.random()}`,
      input: { text: "add a README" },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    const id = started.sessionId;
    expect((await session(id)).planMode).toBe(true);

    const first = await openApproval(id);
    expect(first.title).toBe("Approve the plan and start implementing");
    expect((await answer(id, first.requestId, "deny", "Add tests too")).status).toBe(200);
    await idle(id);
    expect((await session(id)).planMode).toBe(true);

    await h.api("POST", `/sessions/${id}/messages`, { input: { text: "with tests" } });
    const second = await openApproval(id);
    await answer(id, second.requestId, "allow_once");
    await idle(id);
    // The provider reported leaving plan mode, so a resume opens at the permission level.
    expect((await session(id)).planMode).toBe(false);
  });

  it("refuses plan mode, on or off, for a role session", async () => {
    for (const planMode of [false, true]) {
      const res = await h.api("POST", "/sessions", {
        projectId: h.projectId,
        role: "pm",
        provider: "fake",
        planMode,
        purpose: `PM ${Math.random()}`,
      });
      expect(res.status, String(planMode)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "plan_mode_unsupported" } });
    }
  });

  it("turns plan mode on and off for a running session with PATCH", {
    timeout: 60_000,
  }, async () => {
    const id = await h.startFakeSession("first");
    expect((await session(id)).planMode).toBe(false);

    const on = await h.api("PATCH", `/sessions/${id}`, { planMode: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ planMode: true });
    const meta = h.server.services.sessionRepo.find(id)?.startMeta as { pendingConfig?: unknown };
    expect(meta.pendingConfig).toBeUndefined();

    // The next turn plans first.
    await h.api("POST", `/sessions/${id}/messages`, { input: { text: "next" } });
    const approval = await openApproval(id);
    await answer(id, approval.requestId, "deny");
    await idle(id);

    const off = await h.api("PATCH", `/sessions/${id}`, { planMode: false });
    expect(off.body).toMatchObject({ planMode: false });
    expect((await h.api("PATCH", `/sessions/${id}`, { planMode: "yes" })).status).toBe(400);
  });
});

describe("updateSession with planMode", () => {
  it("saves it and sends it to the runner, or keeps it for the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-plan-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const s: Session = { ...sampleSession, id: "s-plan", status: "idle" };
      repo.create(s, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      });
      // Sessions saved before the column existed read as not planning.
      expect(repo.get(s.id).planMode).toBe(false);

      const commands: RunnerCommand[] = [];
      let fail = true;
      const runner = {
        request: async (command: RunnerCommand) => {
          commands.push(command);
          if (fail) throw Object.assign(new Error("timeout"), { code: "timeout" });
          return {};
        },
      } as unknown as RunnerPort;
      await updateSession(repo, runner, s.id, { planMode: true, autonomy: "full" });
      expect(repo.get(s.id)).toMatchObject({ planMode: true, autonomy: "full" });
      // The provider refused (or the runner was away): kept for the next turn, not dropped.
      const pending = () =>
        (repo.find(s.id)?.startMeta as { pendingConfig?: unknown } | null)?.pendingConfig;
      expect(pending()).toEqual({ planMode: true, autonomy: "full" });
      expect(commands).toEqual([
        { name: "session.configure", sessionId: s.id, autonomy: "full", planMode: true },
      ]);
      // Still refused before the next turn: it stays pending and comes with a warning.
      expect(await applyPendingConfig(repo, runner, repo.get(s.id))).toMatch(/not applied live/);
      expect(pending()).toEqual({ planMode: true, autonomy: "full" });
      fail = false;
      await applyPendingConfig(repo, runner, repo.get(s.id));
      expect(commands.at(-1)).toMatchObject({ planMode: true, autonomy: "full" });
      expect(pending()).toBeUndefined();
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionService.start with planMode", () => {
  const info = (id: string, planMode: boolean): ProviderInfo => ({
    id,
    displayName: id,
    models: [],
    capabilities: { ...caps, planMode },
  });

  it("checks plan mode whenever it is given, true or false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-plan-start-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const launch = vi.fn(async () => {});
      const sessions = new SessionService({
        repo,
        projects: {
          get: () => ({
            id: "p1",
            path: dir,
            defaultProvider: null,
            archivedAt: null,
            autonomy: null,
          }),
        },
        runner: {
          providers: () => [info("planner", true), info("plain", false)],
          isConnected: () => true,
        },
        settings: { get: () => Settings.parse({}) },
        launcher: { launch },
      } as unknown as SessionServiceDeps);
      const start = (over: Partial<StartSessionRequestInit>) =>
        sessions.start(
          StartSessionRequest.parse({ projectId: "p1", purpose: `Work ${Math.random()}`, ...over }),
        );

      for (const planMode of [false, true]) {
        await expect(
          start({ provider: "plain", planMode }),
          `plain ${planMode}`,
        ).rejects.toMatchObject({
          status: 400,
          code: "plan_mode_unsupported",
        });
        await expect(
          start({ provider: "planner", role: "pm", planMode }),
          `pm ${planMode}`,
        ).rejects.toMatchObject({ code: "plan_mode_unsupported" });
        const started = await start({ provider: "planner", planMode });
        if (started.status !== "started") throw new Error(started.status);
        expect(repo.get(started.sessionId).planMode).toBe(planMode);
      }
      // Without the field, any provider starts (not planning).
      const plain = await start({ provider: "plain" });
      if (plain.status !== "started") throw new Error(plain.status);
      expect(repo.get(plain.sessionId).planMode).toBe(false);
      expect(launch).toHaveBeenCalledTimes(3);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionLauncher.sessionOptions", () => {
  it("starts and resumes a session in plan mode only while it is planning", () => {
    const launcher = new SessionLauncher({
      runner: { mcpProxyUrl: () => null },
      // No project: the system prompt is written without one.
      projects: {
        get: () => {
          throw new Error("gone");
        },
      },
    } as unknown as LauncherDeps);
    expect(launcher.sessionOptions({ ...sampleSession, planMode: true }).planMode).toBe(true);
    expect(launcher.sessionOptions({ ...sampleSession, planMode: false }).planMode).toBe(false);
    expect(launcher.sessionOptions({ ...sampleSession }).planMode).toBe(false);
  });

  it("sends CodeDen's home, whose credential files are the ones the agent's policy guards", () => {
    const home = join(tmpdir(), "codeden-home");
    const launcher = new SessionLauncher({
      runner: { mcpProxyUrl: () => null },
      projects: { get: () => sampleProjectGone() },
      home,
    } as unknown as LauncherDeps);
    expect(launcher.sessionOptions({ ...sampleSession }).codedenHome).toBe(home);
    // The files the policy guards are the ones the server keeps its credentials in.
    const paths = homePaths(home);
    expect([paths.token, paths.runnerLock, paths.remoteAccess]).toEqual(
      CODEDEN_CREDENTIAL_FILES.map((file) => join(home, file)),
    );
  });
});

function sampleProjectGone(): never {
  throw new Error("gone");
}

describe("planModeUnsupported", () => {
  const provider = (planMode: boolean): ProviderInfo => ({
    id: "other",
    displayName: "Other",
    models: [],
    capabilities: { ...caps, planMode },
  });

  it("allows plan mode for agent sessions on providers that report it", () => {
    expect(planModeUnsupported("agent", provider(true))).toBeNull();
    expect(planModeUnsupported("agent", provider(false))).toMatch(/Other has no plan mode/);
    expect(planModeUnsupported("pm", provider(true))).toMatch(/agent sessions/);
    expect(planModeUnsupported("orchestrator", provider(true))).toMatch(/agent sessions/);
    // An unknown provider (runner not connected yet) is let through, as for read-only.
    expect(planModeUnsupported("agent", undefined)).toBeNull();
  });
});
