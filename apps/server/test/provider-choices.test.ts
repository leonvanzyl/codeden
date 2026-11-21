import type { ProviderStatus } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
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

/** The `provider` parameter of `start_session` as a PM's tool list shows it. */
async function listedProvider(): Promise<{ type?: string; enum?: unknown; description?: string }> {
  const services = { factory: env.factory } as unknown as AppServices;
  const tools = await new ToolRegistry([startSession], services).listNow("pm");
  const properties = tools[0]?.inputSchema.properties as Record<string, object> | undefined;
  return properties?.provider ?? {};
}

describe("start_session's provider parameter", () => {
  it("lists the loaded providers and whether each is ready", async () => {
    env = createFactoryEnv({ providers: ["fake", "gemini"] });
    env.detected.gemini = NOT_INSTALLED;

    const provider = await listedProvider();

    expect(provider.description).toBe(
      "Provider id. Leave it out to use the project's default provider. Loaded providers when this list was made: `fake`: ready; `gemini`: not installed, fix: `npm install -g @google/gemini-cli`. Any other id is refused. Pick one that is ready; one that isn't fails to start until the user fixes it (its state may have changed since).",
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
});
