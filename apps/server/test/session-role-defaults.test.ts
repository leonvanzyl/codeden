import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderInfo,
  Settings,
  type SettingsInput,
  StartSessionRequest,
  type StartSessionRequestInit,
} from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";

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
  reasoningEffort: true,
  mcp: true,
  skills: false,
};

const info = (id: string, reasoningEffort = true): ProviderInfo => ({
  id,
  displayName: id,
  models: [],
  capabilities: { ...caps, reasoningEffort },
});

type Start = (over: Partial<StartSessionRequestInit>) => Promise<string>;

/** A SessionService over a real database, with a scripted runner and the given settings. */
function withService(
  settings: SettingsInput,
  run: (start: Start, repo: SessionRepo) => Promise<void>,
) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-role-defaults-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const parsed = Settings.parse(settings);
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
          // `plain` has no reasoning effort.
          providers: () => [info("claude"), info("codex"), info("plain", false)],
          isConnected: () => true,
        },
        settings: { get: () => parsed },
        launcher: { launch: vi.fn(async () => {}) },
      } as unknown as SessionServiceDeps);
      const start: Start = async (over) => {
        const res = await sessions.start(
          StartSessionRequest.parse({ projectId: "p1", purpose: `Work ${Math.random()}`, ...over }),
        );
        if (res.status !== "started") throw new Error(res.status);
        return res.sessionId;
      };
      await run(start, repo);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("SessionService.start: the role's default model and effort", () => {
  const claudeAgent: SettingsInput = {
    providers: { agent: { provider: "claude", model: "opus", effort: "high" } },
  };

  it(
    "gives a session on another provider that provider's default, not the role's model",
    withService(claudeAgent, async (start, repo) => {
      // A cross-provider reviewer or a fallback builder: the factory picks model null, which it
      // sends as no model at all (`...(model ? { model } : {})`).
      const id = await start({ provider: "codex" });
      expect(repo.get(id)).toMatchObject({ provider: "codex", model: null, effort: null });
    }),
  );

  it(
    "fills the role's model and effort for a session on the role's provider",
    withService(claudeAgent, async (start, repo) => {
      const named = await start({ provider: "claude" });
      expect(repo.get(named)).toMatchObject({ provider: "claude", model: "opus", effort: "high" });
      // Provider resolved from the role's default.
      const resolved = await start({});
      expect(repo.get(resolved)).toMatchObject({
        provider: "claude",
        model: "opus",
        effort: "high",
      });
      // Only the model given: the role's effort still applies on its own provider.
      const sonnet = await start({ provider: "claude", model: "sonnet" });
      expect(repo.get(sonnet)).toMatchObject({ model: "sonnet", effort: "high" });
    }),
  );

  it(
    "keeps an explicit model and effort on another provider",
    withService(claudeAgent, async (start, repo) => {
      const both = await start({ provider: "codex", model: "gpt-5.5", effort: "low" });
      expect(repo.get(both)).toMatchObject({ provider: "codex", model: "gpt-5.5", effort: "low" });
      // A model alone takes no effort from another provider's role default.
      const model = await start({ provider: "codex", model: "gpt-5.5" });
      expect(repo.get(model)).toMatchObject({ model: "gpt-5.5", effort: null });
    }),
  );

  it(
    "leaves the role's effort out on a provider without reasoning effort",
    withService(
      { providers: { agent: { provider: "plain", model: "plain-1", effort: "high" } } },
      async (start, repo) => {
        const id = await start({});
        expect(repo.get(id)).toMatchObject({ provider: "plain", model: "plain-1", effort: null });
      },
    ),
  );

  it(
    "applies the defaults of the session's role, not the agent's",
    withService(
      {
        providers: {
          agent: { provider: "claude", model: "opus", effort: "high" },
          pm: { provider: "codex", model: "gpt-5.5", effort: "medium" },
        },
      },
      async (start, repo) => {
        const pm = await start({ role: "pm" });
        expect(repo.get(pm)).toMatchObject({
          provider: "codex",
          model: "gpt-5.5",
          effort: "medium",
        });
        const pmOnClaude = await start({ role: "pm", provider: "claude" });
        expect(repo.get(pmOnClaude)).toMatchObject({
          provider: "claude",
          model: null,
          effort: null,
        });
      },
    ),
  );
});
