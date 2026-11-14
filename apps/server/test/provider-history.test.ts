import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderCapabilities,
  ProviderInfo,
  RunnerCommand,
  Session,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ProviderHistoryService } from "../src/services/providers/history";
import type { RunnerPort } from "../src/services/runner-port";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

const CAPS: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: true,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  vendorHistory: true,
};

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/**
 * A database with CodeDen's sessions, and a runner whose Codex app lists `visible`: CodeDen's
 * threads plus the user's own `users-own`, which CodeDen never recorded.
 */
function setup(visible = ["t-reviewer", "t-builder", "t-running", "users-own"]) {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "codeden-history-")), "codeden.db"));
  open.push(db);
  const store = new EventStore(db.db);
  const session = (id: string, patch: Partial<Session>) =>
    store.append([
      {
        type: "session.created",
        sessionId: id,
        payload: { session: { ...sampleSession, id, status: "idle", ...patch } },
      },
    ]);
  session("s-reviewer", { provider: "codex", resumeToken: "t-reviewer", title: "Review #12" });
  session("s-builder", { provider: "codex", resumeToken: "t-builder", status: "completed" });
  // Already hidden: the app no longer lists it.
  session("s-old", { provider: "codex", resumeToken: "t-old", status: "stopped" });
  // A turn is running: left alone, the provider hides it when the turn ends.
  session("s-running", { provider: "codex", resumeToken: "t-running", status: "running" });
  session("s-claude", { provider: "claude", resumeToken: "c-1" });
  session("s-new", { provider: "codex", resumeToken: null });

  /** Started since Codex hides as it goes (`StoredStartMeta.vendorHistory`). */
  const mark = (id: string) =>
    db.db
      .update(sessions)
      .set({
        startMeta: {
          workspaceMode: "existing",
          workspaceFallback: null,
          forced: null,
          queuedBehind: [],
          vendorHistory: true,
        },
      })
      .where(eq(sessions.id, id))
      .run();
  /** Sessions the runner hosts (`runner.status`). */
  const hosted = new Set<string>();
  const commands: RunnerCommand[] = [];
  const providers: ProviderInfo[] = [
    { id: "codex", displayName: "Codex", capabilities: CAPS, models: [] },
    {
      id: "claude",
      displayName: "Claude Code",
      capabilities: { ...CAPS, vendorHistory: false },
      models: [],
    },
  ];
  const runner = {
    isConnected: () => true,
    runnerId: () => "rn-home",
    providers: () => providers,
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: async (command: RunnerCommand) => {
      commands.push(command);
      if (command.name === "provider.history.list") {
        // Like a runner that answers for more than it was asked about: CodeDen keeps to its own.
        return {
          entries: visible.map((id) => ({
            resumeToken: id,
            preview: `preview of ${id}`,
            updatedAt: id === "t-builder" ? "2026-11-14T10:00:00.000Z" : "2026-11-13T10:00:00.000Z",
          })),
        };
      }
      if (command.name === "provider.history.hide") {
        return { hidden: command.resumeTokens, missing: [], failed: [] };
      }
      if (command.name === "runner.status") {
        return {
          sessions: [...hosted].map((sessionId) => ({
            sessionId,
            providerId: "codex",
            state: "idle",
            resumeToken: null,
          })),
          ptys: [],
          journal: { lastSeq: 0, unacked: 0 },
          draining: false,
        };
      }
      throw new Error(`unexpected ${command.name}`);
    },
  } as unknown as RunnerPort;
  const service = new ProviderHistoryService({ db: db.db, runner });
  return { service, commands, session, mark, hosted, visible, runner };
}

describe("hiding CodeDen's conversations from a provider's own apps", () => {
  it("previews only the conversations CodeDen recorded that the app still lists", async () => {
    const { service, commands } = setup();
    const preview = await service.preview("codex");

    expect(preview.recorded).toBe(4);
    expect(preview.entries.map((e) => [e.resumeToken, e.sessionId, e.sessionTitle])).toEqual([
      ["t-builder", "s-builder", null],
      ["t-reviewer", "s-reviewer", "Review #12"],
    ]);
    // The runner is only ever asked about recorded, idle conversations.
    expect(commands).toEqual([
      {
        name: "provider.history.list",
        providerId: "codex",
        resumeTokens: expect.arrayContaining(["t-reviewer", "t-builder", "t-old"]),
      },
    ]);
    const asked = (commands[0] as { resumeTokens: string[] }).resumeTokens;
    expect(asked).toHaveLength(3);
    expect(asked).not.toContain("users-own");
    expect(asked).not.toContain("t-running");
  });

  it("hides nothing without the user's confirmation", async () => {
    const { service, commands } = setup();
    for (const request of [undefined, {}, { confirm: false }, { confirm: "yes" }]) {
      await expect(service.hide("codex", request)).rejects.toMatchObject({
        status: 400,
        code: "confirmation_required",
      });
    }
    expect(commands).toEqual([]);
  });

  it("archives exactly the recorded conversations the app lists, never the user's own", async () => {
    const { service, commands } = setup();
    const result = await service.hide("codex", { confirm: true });

    expect(result).toEqual({
      providerId: "codex",
      hidden: ["t-reviewer", "t-builder"],
      missing: [],
      failed: [],
    });
    const hide = commands.filter((c) => c.name === "provider.history.hide");
    expect(hide).toEqual([
      {
        name: "provider.history.hide",
        providerId: "codex",
        resumeTokens: ["t-reviewer", "t-builder"],
      },
    ]);
  });

  it("asks nothing to hide when the app lists none of CodeDen's conversations", async () => {
    const { service, commands } = setup(["users-own"]);
    expect((await service.preview("codex")).entries).toEqual([]);
    const result = await service.hide("codex", { confirm: true });
    expect(result.hidden).toEqual([]);
    expect(commands.some((c) => c.name === "provider.history.hide")).toBe(false);
  });

  it("refuses a provider whose app CodeDen can't hide conversations from", async () => {
    const { service, commands } = setup();
    await expect(service.preview("claude")).rejects.toMatchObject({
      status: 409,
      code: "unsupported",
    });
    await expect(service.hide("claude", { confirm: true })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(commands).toEqual([]);
  });
});

describe("the sweep when a runner starts", () => {
  it("hides what a crash left listed, only for sessions run since Codex hides as it goes", async () => {
    const t = setup();
    t.visible.push("t-hosted", "t-starting");
    // Run since the provider hides its conversations, idle: a killed runner never archived it.
    t.mark("s-reviewer");
    t.mark("s-running");
    // Hosted again (its provider process holds the thread) or being started: left alone.
    t.session("s-hosted", { provider: "codex", resumeToken: "t-hosted" });
    t.mark("s-hosted");
    t.hosted.add("s-hosted");
    t.session("s-starting", { provider: "codex", resumeToken: "t-starting" });
    t.mark("s-starting");
    // s-builder is from before: the user confirms hiding it (Settings > Providers).

    const result = await t.service.sweep(t.runner, (id) => id === "s-starting");

    expect(result).toEqual({ hidden: ["t-reviewer"], failed: 0 });
    const asked = t.commands.find((c) => c.name === "provider.history.list") as {
      resumeTokens: string[];
    };
    expect(asked.resumeTokens).toEqual(["t-reviewer"]);
    expect(t.commands.filter((c) => c.name === "provider.history.hide")).toEqual([
      { name: "provider.history.hide", providerId: "codex", resumeTokens: ["t-reviewer"] },
    ]);
  });

  it("does nothing when no conversation needs it, and never throws", async () => {
    const t = setup();
    expect(await t.service.sweep(t.runner)).toEqual({ hidden: [], failed: 0 });
    expect(t.commands.some((c) => c.name === "provider.history.hide")).toBe(false);

    t.mark("s-reviewer");
    const away = { ...t.runner, isConnected: () => false } as RunnerPort;
    expect(await t.service.sweep(away)).toEqual({ hidden: [], failed: 0 });
    const failing = {
      ...t.runner,
      request: async () => {
        throw new Error("runner gone");
      },
    } as unknown as RunnerPort;
    expect(await t.service.sweep(failing)).toEqual({ hidden: [], failed: 0 });
  });
});

describe("which sessions the sweep covers", () => {
  it("marks a session when it is started on a provider that hides as it goes", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "codeden-history-")), "codeden.db"));
    open.push(db);
    const repo = new SessionRepo(db.db, new EventStore(db.db));
    const meta = {
      workspaceMode: "existing" as const,
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
    };
    for (const provider of ["codex", "claude"]) {
      repo.create({ ...sampleSession, id: `s-${provider}`, provider, status: "created" }, meta);
    }
    const runner = {
      mcpProxyUrl: () => null,
      providers: () => [
        { id: "codex", displayName: "Codex", capabilities: CAPS, models: [] },
        {
          id: "claude",
          displayName: "Claude Code",
          capabilities: { ...CAPS, vendorHistory: false },
        },
      ],
      request: async () => ({ resumeToken: "t-1" }),
    } as unknown as RunnerPort;
    const launcher = new SessionLauncher({
      runner,
      repo,
      home: tmpdir(),
    } as unknown as LauncherDeps);
    // Every start and resume goes through `open` (`session.start`).
    const start = (
      launcher as unknown as { open: (...a: unknown[]) => Promise<unknown> }
    ).open.bind(launcher);
    await start(runner, repo.get("s-codex"), undefined);
    await start(runner, repo.get("s-claude"), undefined);
    expect(repo.find("s-codex")?.startMeta?.vendorHistory).toBe(true);
    expect(repo.find("s-claude")?.startMeta?.vendorHistory).toBeUndefined();
    // The rest of the start metadata is kept.
    expect(repo.find("s-codex")?.startMeta).toMatchObject(meta);
  });
});
