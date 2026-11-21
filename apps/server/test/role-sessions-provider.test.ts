import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderInfo, type Session, Settings, type SettingsInput } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RoleSessions } from "../src/services/orchestration/role-sessions";
import type { ProjectService } from "../src/services/projects/project-service";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { removeTree } from "./support/remove-tree";

const info = (id: string): ProviderInfo =>
  ({ id, displayName: id, models: [], capabilities: {} }) as unknown as ProviderInfo;

interface Env {
  roles: RoleSessions;
  repo: SessionRepo;
  /** Change the settings, as `PATCH /api/settings` does before it applies them to the roles. */
  set(settings: SettingsInput): void;
  /** End the session's turn with `status`. */
  settle(id: string, status?: Session["status"]): void;
  stopped: string[];
}

/** Role sessions over a real database and SessionService, with a scripted runner. */
function withRoles(run: (env: Env) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-role-provider-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      let settings = Settings.parse({});
      const stopped: string[] = [];
      const project = {
        id: "p1",
        name: "app",
        slug: "app",
        path: dir,
        defaultProvider: null,
        archivedAt: null,
        autonomy: null,
      };
      const projects = { get: () => project } as unknown as ProjectService;
      const sessions = new SessionService({
        repo,
        projects,
        runner: {
          // Only these two are loaded: `gemini` stands for a provider the runner doesn't have.
          providers: () => [info("claude"), info("codex")],
          isConnected: () => true,
          request: vi.fn(async (command: { name: string; sessionId: string }) => {
            if (command.name === "session.stop") stopped.push(command.sessionId);
          }),
        },
        settings: { get: () => settings },
        launcher: { launch: vi.fn(async () => {}) },
        outbox: { clear: () => {} },
        tokens: { revokeSession: () => {} },
        inbox: { dismissRequestsForSession: () => {} },
      } as unknown as SessionServiceDeps);
      await run({
        roles: new RoleSessions({ db: database.db, repo, sessions, projects }),
        repo,
        set: (next) => {
          settings = Settings.parse(next);
        },
        settle: (id, status = "idle") => {
          repo.update(id, (s) => ({ ...s, status }));
        },
        stopped,
      });
    } finally {
      database.close();
      await removeTree(dir);
    }
  };
}

describe("role sessions: moving the orchestrator or a PM to another provider (§8.1)", () => {
  it(
    "retires the PM when its role's provider changes, and starts a fresh one on next use",
    withRoles(async ({ roles, repo, set, settle, stopped }) => {
      const first = await roles.ensure("pm", "p1");
      expect(first.provider).toBe("claude");
      // Its turn failed, e.g. "Not logged in".
      settle(first.id, "failed");

      set({ providers: { pm: { provider: "codex" } } });
      await roles.applyProviderSettings();

      expect(stopped).toEqual([first.id]);
      expect(repo.get(first.id).archivedAt).not.toBeNull();
      // The role shows as not started until its next message.
      expect(roles.find("pm", "p1")).toBeUndefined();
      expect(roles.refs().pms).toEqual({});

      const second = await roles.ensure("pm", "p1");
      expect(second.id).not.toBe(first.id);
      expect(second.provider).toBe("codex");
      expect(roles.refs().pms).toEqual({ p1: second.id });
      // Settled on the chosen provider: nothing more to retire.
      settle(second.id);
      await roles.applyProviderSettings();
      expect((await roles.ensure("pm", "p1")).id).toBe(second.id);
    }),
  );

  it(
    "leaves a session with a turn under way, and moves it when it is next used",
    withRoles(async ({ roles, repo, set, settle }) => {
      const first = await roles.ensure("orchestrator", null);
      settle(first.id, "running");
      set({ providers: { orchestrator: { provider: "codex" } } });
      await roles.applyProviderSettings();
      expect(repo.get(first.id).archivedAt).toBeNull();
      expect((await roles.ensure("orchestrator", null)).id).toBe(first.id);

      settle(first.id);
      const second = await roles.ensure("orchestrator", null);
      expect(second.provider).toBe("codex");
      expect(repo.get(first.id).archivedAt).not.toBeNull();
    }),
  );

  it(
    "keeps the session for Auto, for the other role's setting and for a provider the runner lacks",
    withRoles(async ({ roles, repo, set, settle }) => {
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      for (const providers of [
        { pm: { provider: "auto" } },
        { orchestrator: { provider: "codex" }, agent: { provider: "codex" } },
        { pm: { provider: "gemini" } },
        { pm: { provider: "claude" } },
      ] satisfies SettingsInput["providers"][]) {
        set({ providers });
        await roles.applyProviderSettings();
        expect(repo.get(pm.id).archivedAt).toBeNull();
        expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      }
    }),
  );
});
