import type { ProviderStatus } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AnyServerTool } from "../src/mcp/define";
import { ToolRegistry } from "../src/mcp/registry";
import { createProject, updateProject } from "../src/mcp/tools/orchestrator/projects";
import { startSession } from "../src/mcp/tools/pm/sessions";
import { providerChoicesText } from "../src/mcp/tools/shared/provider-choices";
import type { AppServices } from "../src/services/container";
import { untilText } from "../src/services/factory/availability";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

// Issue #569: `start_session` took a free-form `provider` and its schema didn't say which ids
// exist, so a PM found out by starting sessions and reading the failures.

let env: FactoryEnv;
afterEach(() => env?.close());

const NOT_INSTALLED: Partial<ProviderStatus> = {
  installed: false,
  loggedIn: null,
  issues: [
    {
      code: "not_installed",
      message: "Gemini CLI is not installed (no `gemini` on PATH)",
      fix: { kind: "install", command: "npm install -g @google/gemini-cli" },
    },
  ],
};

/** A provider parameter as a role's tool list shows it. */
async function listed(
  tool: AnyServerTool,
  role: "pm" | "orchestrator",
  param: string,
): Promise<{ type?: string; enum?: unknown; description?: string }> {
  const services = { factory: env.factory } as unknown as AppServices;
  const tools = await new ToolRegistry([tool], services).listNow(role);
  const properties = tools[0]?.inputSchema.properties as Record<string, object> | undefined;
  return properties?.[param] ?? {};
}

/** The `provider` parameter of `start_session` as a PM's tool list shows it. */
const listedProvider = () => listed(startSession as AnyServerTool, "pm", "provider");

/** What the listing says of each provider: "`gemini`: not installed, fix: `npm i …`". */
async function listedStates(): Promise<string[]> {
  const text = (await listedProvider()).description ?? "";
  const list = /Loaded providers when this list was made: (.*?)\. An id that/.exec(text)?.[1];
  return list?.split("; ") ?? [];
}

const START_SESSION_HEAD =
  "Provider id. Leave it out to use the project's default provider when it is ready, else the default provider for agents in Settings when it is ready (when that is auto, the first ready provider in a fixed order); when none of them is ready, the call is refused with this list. Loaded providers when this list was made: ";
const START_SESSION_TAIL =
  ". An id that isn't loaded is refused while the runner is connected. A provider you name isn't checked for readiness: on one that isn't ready the session is created and then fails to start or fails its first turn, so pick one that is ready. The states are from the last check and may have changed since.";

describe("start_session's provider parameter", () => {
  it("lists the loaded providers and whether each is ready", async () => {
    env = createFactoryEnv({ providers: ["fake", "gemini"] });
    env.detected.gemini = NOT_INSTALLED;

    const provider = await listedProvider();

    expect(provider.description).toBe(
      `${START_SESSION_HEAD}\`fake\`: ready; \`gemini\`: not installed, fix: \`npm install -g @google/gemini-cli\`${START_SESSION_TAIL}`,
    );
    // Still a string, so a provider that became ready after the listing isn't refused.
    expect(provider.type).toBe("string");
    expect(provider.enum).toBeUndefined();
    // Detected once for the listing; the next listing uses what is known.
    await listedProvider();
    expect(env.detections).toBe(1);
  });

  it("says so when no provider is loaded", async () => {
    env = createFactoryEnv({ providers: [] });
    expect((await listedProvider()).description).toContain("No provider is loaded right now");
  });

  it("names every state that keeps new work off a provider, and calls the rest ready", async () => {
    env = createFactoryEnv({
      providers: [
        "broken",
        "old",
        "signedout",
        "limited",
        "backoff",
        "codex",
        "unsure",
        "untested",
        "soon",
      ],
    });
    const fix = (kind: "install" | "login" | "upgrade") => ({ kind, command: `x ${kind}` });
    env.detected.broken = {
      installed: false,
      loggedIn: null,
      issues: [
        { code: "broken_install", message: "points at a missing package", fix: fix("install") },
      ],
    };
    env.detected.old = {
      version: "0.36.0",
      issues: [
        {
          code: "version_unsupported",
          message: "too old",
          minVersion: "0.68.0",
          fix: fix("upgrade"),
        },
      ],
    };
    env.detected.signedout = {
      loggedIn: false,
      issues: [{ code: "not_logged_in", message: "not signed in", fix: fix("login") }],
    };
    const resets = new Date(env.now().getTime() + 30 * 60 * 60_000).toISOString();
    env.rateLimits.push({
      provider: "limited",
      status: "limited",
      resetsAt: resets,
      observedAt: env.now().toISOString(),
    });
    // Factory sessions failed because of their provider, which backs it off for new work
    // (`provider-failure.ts`): a usage limit until its reset, a sign-in until the login changes.
    const sessions = env.factory.ctx.sessions;
    sessions.providerFailed("backoff", { reason: "at its usage limit", until: resets });
    sessions.providerFailed("codex", { reason: "not signed in", until: null, signin: true });
    // Detection found nothing that stops new work, so these read "ready" (as the factory counts
    // them): a sign-in it couldn't read, a version outside the tested range, a login about to end.
    env.detected.unsure = {
      loggedIn: null,
      issues: [{ code: "detect_failed", message: "Could not read the login" }],
    };
    env.detected.untested = {
      supported: false,
      issues: [{ code: "version_unsupported", message: "older than tested", fix: fix("upgrade") }],
    };
    env.detected.soon = {
      issues: [{ code: "login_expiring", message: "expires soon", fix: fix("login") }],
    };

    expect(await listedStates()).toEqual([
      "`broken`: not installed, fix: `x install`",
      "`old`: too old (0.36.0, needs 0.68.0+), fix: `x upgrade`",
      "`signedout`: not signed in, fix: `x login`",
      `\`limited\`: at its usage limit${untilText(resets)}`,
      `\`backoff\`: at its usage limit${untilText(resets)}`,
      "`codex`: not signed in, fix: `codex login`",
      "`unsure`: ready",
      "`untested`: ready",
      "`soon`: ready",
    ]);
  });

  it("reads 'not checked yet' until a detection has answered", () => {
    const unknown = { reason: null, until: null, detail: null, fix: null, message: null };
    expect(
      providerChoicesText(
        [{ id: "fake", name: "Fake (scripted)", checked: false, runnable: true, ...unknown }],
        "Omitted.",
        "Rules.",
      ),
    ).toBe(
      "Provider id. Omitted. Loaded providers when this list was made: `fake` (Fake (scripted)): not checked yet. Rules. The states are from the last check and may have changed since.",
    );
  });

  it("is built for each listing from the last detection, which a listing renews in the background", async () => {
    env = createFactoryEnv({ providers: ["gemini"] });
    expect(await listedStates()).toEqual(["`gemini`: ready"]);

    // The CLI is removed. Within the detection interval (5 minutes) a listing doesn't look again.
    env.detected.gemini = NOT_INSTALLED;
    expect(await listedStates()).toEqual(["`gemini`: ready"]);
    expect(env.detections).toBe(1);

    // After it, a listing starts a new detection in the background without waiting for it (it
    // may still answer from the old one)...
    env.clock.offsetMs += 6 * 60_000;
    await listedStates();
    expect(env.detections).toBe(2);
    // ...whose result the next listing shows.
    expect(await listedStates()).toEqual([
      "`gemini`: not installed, fix: `npm install -g @google/gemini-cli`",
    ]);
  });
});

describe("the orchestrator's defaultProvider parameter", () => {
  it("lists the same providers and says an id that isn't loaded is refused", async () => {
    env = createFactoryEnv({ providers: ["fake", "gemini"] });
    env.detected.gemini = NOT_INSTALLED;
    const expected =
      "Provider id. The provider this project's sessions use unless one is named. Loaded providers when this list was made: `fake`: ready; `gemini`: not installed, fix: `npm install -g @google/gemini-cli`. An id that isn't loaded is refused while the runner is connected. A session uses it only while it is loaded (one the PM starts without naming a provider, only while it is ready), and otherwise falls back to the Settings default. Pick one that is ready. The states are from the last check and may have changed since.";
    for (const tool of [createProject, updateProject]) {
      const param = await listed(tool as AnyServerTool, "orchestrator", "defaultProvider");
      expect(param.description).toBe(expected);
    }
  });
});
