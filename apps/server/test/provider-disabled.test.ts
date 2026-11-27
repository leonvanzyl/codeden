import { StartSessionRequest } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { withRoles } from "./support/role-env";

// Issue #652: a detected provider the user doesn't use (Cursor without a licence) couldn't be
// turned off, so the factory picked it for reviews and stalled. A provider turned off in
// Settings → Providers (`settings.providers.disabled`) is never chosen for new work.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, openPr } = factorySteps(() => env);

/** Let the background detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));

describe("factory with a provider turned off in Settings", () => {
  it("runs neither builders nor reviews on it, and says why", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex", "cursor"] });
    env.settings.update({ providers: { disabled: ["cursor"] } });
    enable("software_factory", {
      tuning: { builderProvider: "cursor", reviewerProvider: "cursor", reviewerFallback: "any" },
    });
    await tick();
    await settle();
    const created = backlogItem();
    await tick();
    await openPr(created.id);
    await tick();

    expect(item(created.id).stage).toBe("verifying");
    expect(env.starts.map((s) => s.provider)).not.toContain("cursor");
    expect(item(created.id).reviewerNote).toMatch(/cursor is turned off in Settings/);
    expect(env.factory.providerRunnable("cursor")).toMatchObject({
      runnable: false,
      reason: "turned off in Settings",
    });
    // The PM's provider list says so too, and the others stay ready.
    const choices = await env.factory.providerChoices();
    expect(choices.find((c) => c.id === "cursor")).toMatchObject({ runnable: false });
    expect(choices.filter((c) => c.runnable).map((c) => c.id)).toEqual(["claude", "codex"]);

    // Turned on again: new work can use it.
    env.settings.update({ providers: { disabled: [] } });
    expect(env.factory.providerRunnable("cursor").runnable).toBe(true);
  });
});

describe("new sessions with a provider turned off in Settings", () => {
  it(
    "skips it for Auto and for a default that names it",
    withRoles(async ({ roles, set }) => {
      await set({ providers: { disabled: ["claude"] } });
      expect((await roles.ensure("pm", "p1")).provider).toBe("codex");
      await set({ providers: { disabled: ["claude"], orchestrator: { provider: "claude" } } });
      expect((await roles.ensure("orchestrator", null)).provider).toBe("codex");
    }),
  );

  it(
    "refuses to start a session on it, or when every provider is turned off",
    withRoles(async ({ sessions, set }) => {
      await set({ providers: { disabled: ["claude"] } });
      const start = (provider: string) =>
        sessions.start(
          StartSessionRequest.parse({
            role: "orchestrator",
            projectId: null,
            provider,
            startedBy: { kind: "user" },
          }),
        );
      await expect(start("claude")).rejects.toMatchObject({ code: "provider_disabled" });
      await set({ providers: { disabled: ["claude", "codex"] } });
      await expect(start("auto")).rejects.toThrow(/Every provider is turned off/);
    }),
  );
});
