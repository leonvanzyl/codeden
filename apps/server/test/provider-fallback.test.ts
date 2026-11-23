import type { ProviderStatus } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, updateProject } from "../src/mcp/tools/orchestrator/projects";
import { startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

// Issue #623: `start_session` without a provider fell back to a default the runner hadn't loaded
// or that wasn't signed in, and `update_project` stored any provider id as the project's default.

let env: FactoryEnv;
afterEach(() => env?.close());

const SIGNED_OUT: Partial<ProviderStatus> = {
  loggedIn: false,
  issues: [
    {
      code: "not_logged_in",
      message: "Codex is not signed in",
      fix: { kind: "login", command: "codex login" },
    },
  ],
};
const NOT_INSTALLED: Partial<ProviderStatus> = {
  installed: false,
  loggedIn: null,
  issues: [
    {
      code: "not_installed",
      message: "Gemini CLI is not installed",
      fix: { kind: "install", command: "npm install -g @google/gemini-cli" },
    },
  ],
};

/** The services the tools use, over the env's scripted runner and session service. */
const services = () =>
  ({
    factory: env.factory,
    sessions: env.sessions,
    projects: env.factory.ctx.projects,
    settings: env.settings,
  }) as unknown as AppServices;

const ctx = (role: "pm" | "orchestrator") =>
  ({
    services: services(),
    role,
    caller: "mcp",
    signal: new AbortController().signal,
    projectId: env.project.id,
    sessionId: null,
  }) as never;

/** A PM's `start_session` without a provider; the provider the session service was asked for. */
async function startWithoutProvider(extra: Record<string, unknown> = {}) {
  await startSession.handler(
    { prompt: "Fix the parser", purpose: "Fix the parser", workKey: "request:parser", ...extra },
    ctx("pm"),
  );
  return env.starts.at(-1)?.provider;
}

describe("start_session without a provider", () => {
  it("skips a project default that isn't ready for the Settings default", async () => {
    env = createFactoryEnv({ providers: ["codex", "gemini", "fake"] });
    env.detected.codex = SIGNED_OUT;
    env.updateProject({ defaultProvider: "codex" });
    env.settings.update({ providers: { agent: { provider: "fake" } } });

    expect(await startWithoutProvider()).toBe("fake");
  });

  it("uses the project default when it is ready", async () => {
    env = createFactoryEnv({ providers: ["codex", "fake"] });
    env.updateProject({ defaultProvider: "codex" });
    env.settings.update({ providers: { agent: { provider: "fake" } } });

    expect(await startWithoutProvider()).toBe("codex");
  });

  it("with the Settings default on auto, takes the first ready provider, in auto's order", async () => {
    env = createFactoryEnv({ providers: ["fake", "gemini", "codex"] });
    env.detected.codex = SIGNED_OUT;
    // Codex comes before Gemini in auto's order, but it is signed out.
    expect(await startWithoutProvider()).toBe("gemini");
  });

  it("is refused, naming the loaded providers, when no default is ready", async () => {
    env = createFactoryEnv({ providers: ["codex", "gemini", "fake"] });
    env.detected.codex = SIGNED_OUT;
    env.detected.gemini = NOT_INSTALLED;
    env.updateProject({ defaultProvider: "codex" });
    env.settings.update({ providers: { agent: { provider: "gemini" } } });

    await expect(startWithoutProvider()).rejects.toThrow(
      "No provider is ready for this session: the project's default provider, `codex`, is not signed in, fix: `codex login`; the default provider for agents in Settings, `gemini`, is not installed, fix: `npm install -g @google/gemini-cli`. Name a ready one in provider. Loaded providers: `codex`: not signed in, fix: `codex login`; `gemini`: not installed, fix: `npm install -g @google/gemini-cli`; `fake`: ready.",
    );
    expect(env.starts).toEqual([]);
  });

  it("is refused when the Settings default is auto and nothing loaded is ready", async () => {
    env = createFactoryEnv({ providers: ["codex", "gemini"] });
    env.detected.codex = SIGNED_OUT;
    env.detected.gemini = NOT_INSTALLED;

    await expect(startWithoutProvider()).rejects.toThrow(
      "No provider is ready for this session: the default for agents in Settings is auto and no loaded provider is ready.",
    );
    expect(env.starts).toEqual([]);
  });

  it("says a default the runner didn't load isn't loaded", async () => {
    env = createFactoryEnv({ providers: ["codex"] });
    env.detected.codex = SIGNED_OUT;
    env.updateProject({ defaultProvider: "antigravity" });

    await expect(startWithoutProvider()).rejects.toThrow(
      "the project's default provider, `antigravity`, isn't loaded;",
    );
  });

  it("checks nothing when a provider is named, or when joining or skipping starts nothing", async () => {
    env = createFactoryEnv({ providers: ["codex"] });
    env.detected.codex = SIGNED_OUT;

    expect(await startWithoutProvider({ provider: "codex" })).toBe("codex");
    expect(await startWithoutProvider({ conflict: { resolution: "skip" } })).toBeUndefined();
  });
});

describe("the orchestrator's defaultProvider", () => {
  it("refuses an id the runner hasn't loaded, naming the loaded providers", async () => {
    env = createFactoryEnv({ providers: ["fake", "gemini"] });
    env.detected.gemini = NOT_INSTALLED;
    const call = (defaultProvider: string | null) =>
      updateProject.handler({ projectId: env.project.id, defaultProvider }, ctx("orchestrator"));

    await expect(call("antigravity")).rejects.toThrow(
      "Provider antigravity is not available. Loaded providers: `fake`: ready; `gemini`: not installed, fix: `npm install -g @google/gemini-cli`.",
    );
    expect(env.factory.ctx.projects.get(env.project.id).defaultProvider).toBeNull();

    // A loaded one is stored, ready or not, and null clears it.
    await call("gemini");
    expect(env.factory.ctx.projects.get(env.project.id).defaultProvider).toBe("gemini");
    await call(null);
    expect(env.factory.ctx.projects.get(env.project.id).defaultProvider).toBeNull();

    await expect(
      createProject.handler({ path: env.dir, defaultProvider: "antigravity" }, ctx("orchestrator")),
    ).rejects.toThrow("Provider antigravity is not available.");
  });
});
