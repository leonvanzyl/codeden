import type { ProviderInfo, SetupCheck } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  adjacentTab,
  chooseModel,
  clampEffort,
  effectiveEffort,
  effortLevels,
  FAVORITES_TAB,
  favoriteRows,
  modelName,
  providerAvailability,
  providerTabs,
  resolveModel,
  searchRows,
  sortEfforts,
  tabRows,
  toggleFavorite,
  triggerText,
} from "@/components/composer/model-picker/logic";
import { providers } from "@/lib/api/mock/fixtures/world";

const claude = providers.find((p) => p.id === "claude") as ProviderInfo;
const codex = providers.find((p) => p.id === "codex") as ProviderInfo;
const model = (p: ProviderInfo, id: string) => {
  const m = p.models.find((x) => x.id === id);
  if (!m) throw new Error(`no model ${id}`);
  return m;
};

const check = (c: Partial<SetupCheck> & Pick<SetupCheck, "id">): SetupCheck => ({
  label: c.id,
  state: "ok",
  installed: true,
  version: null,
  executablePath: null,
  loggedIn: true,
  authMethod: null,
  account: null,
  loginExpiresAt: null,
  message: "",
  fix: null,
  durationMs: 1,
  ...c,
});

describe("effort rules", () => {
  it("orders levels from lowest to highest", () => {
    expect(sortEfforts(["max", "low", "high", "low"])).toEqual(["low", "high", "max"]);
  });

  it("keeps a supported effort, else the model default, else the nearest level", () => {
    expect(clampEffort(["low", "medium", "high"], "high", "medium")).toBe("high");
    expect(clampEffort(["low", "medium", "high"], "max", "medium")).toBe("medium");
    expect(clampEffort(["medium", "high"], "minimal")).toBe("medium");
    expect(clampEffort(["low", "medium"], "max")).toBe("medium");
  });

  it("returns null for models without levels and keeps null as 'use the default'", () => {
    expect(clampEffort([], "high", "high")).toBeNull();
    expect(clampEffort(["low", "high"], null, "low")).toBeNull();
  });

  it("resolves the effort that will run", () => {
    expect(effectiveEffort(["low", "medium", "high"], null, "medium")).toBe("medium");
    expect(effectiveEffort(["low", "medium", "high"], "xhigh", "low")).toBe("low");
    expect(effectiveEffort(["low", "medium", "high"], null)).toBe("medium");
    expect(effectiveEffort([], "high", "high")).toBeNull();
  });

  it("offers no levels when the provider has no effort capability", () => {
    const flat = { ...claude, capabilities: { ...claude.capabilities, reasoningEffort: false } };
    expect(effortLevels(flat, model(flat, "opus"))).toEqual([]);
    expect(effortLevels(claude, model(claude, "opus"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("chooseModel", () => {
  it("keeps the effort when the new model supports it", () => {
    const next = chooseModel(
      { provider: "claude", model: "opus", effort: "high" },
      claude,
      model(claude, "sonnet"),
    );
    expect(next).toEqual({ provider: "claude", model: "sonnet", effort: "high" });
  });

  it("clamps to the new model's default when the effort is not supported", () => {
    const next = chooseModel(
      { provider: "claude", model: "opus", effort: "max" },
      claude,
      model(claude, "sonnet"),
    );
    expect(next.effort).toBe("medium");
  });

  it("falls back to the nearest level when the model has no default", () => {
    const noDefault = { id: "x", label: "x", efforts: ["medium", "high"] as const };
    const next = chooseModel({ provider: "codex", model: null, effort: "minimal" }, codex, {
      ...noDefault,
      efforts: [...noDefault.efforts],
    });
    expect(next.effort).toBe("medium");
  });

  it("clears the effort for a model without levels, and keeps it across providers", () => {
    expect(
      chooseModel(
        { provider: "claude", model: "opus", effort: "max" },
        claude,
        model(claude, "haiku"),
      ).effort,
    ).toBeNull();
    expect(
      chooseModel(
        { provider: "claude", model: "opus", effort: "max" },
        codex,
        model(codex, "gpt-6-astra"),
      ),
    ).toEqual({ provider: "codex", model: "gpt-6-astra", effort: "max" });
  });
});

describe("resolveModel", () => {
  it('treats null and "default" as the provider\'s default model', () => {
    for (const id of [null, "default"]) {
      const resolved = resolveModel(codex, id);
      expect(resolved).toEqual({
        model: model(codex, "gpt-6.1-sol"),
        followsDefault: true,
        missing: null,
      });
      expect(modelName(resolved)).toBe("Default (gpt-6.1-sol)");
      expect(triggerText(codex, resolved)).toBe("Default (gpt-6.1-sol)");
    }
  });

  it('uses a listed "default" entry as-is before the provider lists its models', () => {
    const fallback = {
      ...codex,
      models: [{ id: "default", label: "Default", efforts: [], isDefault: true }],
    };
    for (const id of [null, "default"]) {
      const resolved = resolveModel(fallback, id);
      expect(resolved.followsDefault).toBe(false);
      expect(triggerText(fallback, resolved)).toBe("Codex · Default");
    }
  });

  it("keeps an id the provider no longer lists instead of swapping in another model", () => {
    const resolved = resolveModel(codex, "gpt-4-retired");
    expect(resolved).toEqual({ model: undefined, followsDefault: false, missing: "gpt-4-retired" });
    expect(triggerText(codex, resolved)).toBe("gpt-4-retired");
    expect(resolveModel(undefined, "x").missing).toBe("x");
  });

  it("names an exact model by its label", () => {
    expect(triggerText(codex, resolveModel(codex, "gpt-6-nova"))).toBe("gpt-6-nova");
  });
});

describe("availability", () => {
  it("reads installed and signed-in state from the setup checks", () => {
    const checks = [
      check({ id: "claude" }),
      check({
        id: "codex",
        state: "missing",
        loggedIn: false,
        message: "Installed but not signed in",
        fix: { kind: "login", command: "codex login" },
      }),
    ];
    expect(providerAvailability("claude", checks).ready).toBe(true);
    expect(providerAvailability("codex", checks)).toEqual({
      ready: false,
      reason: "Not signed in",
      detail: "Installed but not signed in",
      command: "codex login",
    });
    expect(
      providerAvailability("codex", [check({ id: "codex", state: "missing", installed: false })])
        .reason,
    ).toBe("Not installed");
    expect(
      providerAvailability("codex", [
        check({
          id: "codex",
          state: "missing",
          installed: false,
          broken: [{ path: "C:\\npm\\codex.cmd", reason: "points at a missing package" }],
        }),
      ]).reason,
    ).toBe("Installed but broken");
  });

  it("treats providers without a check (or before detection) as ready", () => {
    expect(providerAvailability("fake", [check({ id: "claude" })]).ready).toBe(true);
    expect(providerAvailability("codex", undefined).ready).toBe(true);
  });
});

describe("tabs", () => {
  it("locks every other provider when the provider is fixed", () => {
    const tabs = providerTabs(providers, undefined, "codex");
    expect(tabs.find((t) => t.id === "codex")?.lockedReason).toBeNull();
    expect(tabs.find((t) => t.id === "claude")?.lockedReason).toMatch(/Start a new session/);
  });

  it("moves between open tabs, skipping locked ones and wrapping", () => {
    const fake = { ...claude, id: "fake", displayName: "Fake" };
    const tabs = providerTabs([claude, codex, fake], undefined, undefined);
    expect(adjacentTab(tabs, "claude", 1)?.id).toBe("codex");
    expect(adjacentTab(tabs, "fake", 1)?.id).toBe("claude");
    expect(adjacentTab(tabs, "claude", -1)?.id).toBe("fake");
    const locked = providerTabs([claude, codex, fake], undefined, "codex");
    expect(adjacentTab(locked, "codex", 1)?.id).toBe("codex");
  });
});

describe("search", () => {
  it("matches every token across model, id, provider and description", () => {
    // "codex" names the provider, so every Codex model matches it; "mini" narrows them.
    expect(searchRows(providers, "codex mini").map((r) => r.model.id)).toEqual([
      "gpt-6.1-sol-mini",
      "gpt-6-astra-mini",
      "gpt-5.6-luna-mini",
    ]);
    expect(searchRows(providers, "claude son").map((r) => r.model.id)).toEqual(["sonnet"]);
    expect(searchRows(providers, "nothing like this")).toEqual([]);
  });

  it("puts an exact name first and finds descriptions too", () => {
    expect(searchRows(providers, "gpt-6-astra").map((r) => r.model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-astra-mini",
    ]);
    const fast = searchRows(providers, "fast").map((r) => r.model.id);
    expect(fast).toEqual(expect.arrayContaining(["sonnet", "haiku", "gpt-6.1-sol-mini"]));
  });
});

describe("favourites", () => {
  const favorites = [
    { provider: "codex", model: "gpt-6-nova" },
    { provider: "codex", model: "gpt-4-retired" },
    { provider: "gone", model: "x" },
    { provider: "claude", model: "opus" },
    { provider: "codex", model: "gpt-6-nova" },
  ];

  it("lists favourites in order, without models or providers that are gone, once each", () => {
    expect(favoriteRows(favorites, providers).map((r) => r.key)).toEqual([
      "codex::gpt-6-nova",
      "claude::opus",
    ]);
    expect(favoriteRows(favorites, [claude]).map((r) => r.key)).toEqual(["claude::opus"]);
  });

  it("adds and removes a favourite, keeping the order of the rest", () => {
    const list = [
      { provider: "codex", model: "a" },
      { provider: "claude", model: "b" },
    ];
    expect(toggleFavorite(list, { provider: "codex", model: "c" })).toEqual([
      ...list,
      { provider: "codex", model: "c" },
    ]);
    expect(toggleFavorite(list, { provider: "codex", model: "a" })).toEqual([list[1]]);
  });

  it("puts the Favourites tab first and can move to it", () => {
    const tabs = providerTabs(providers, undefined, undefined, { favorites: true });
    expect(tabs.map((t) => t.id)).toEqual([FAVORITES_TAB, "claude", "codex", "opencode"]);
    expect(adjacentTab(tabs, "claude", -1)?.id).toBe(FAVORITES_TAB);
    expect(tabRows(tabs[0], providers, favorites).map((r) => r.model.id)).toEqual([
      "gpt-6-nova",
      "opus",
    ]);
  });

  it("ranks favourites first among equal search matches", () => {
    const starred = [{ provider: "codex", model: "gpt-5.6-luna-mini" }];
    expect(searchRows(providers, "mini", starred).map((r) => r.model.id)).toEqual([
      "gpt-5.6-luna-mini",
      "gpt-6.1-sol-mini",
      "gpt-6-astra-mini",
    ]);
  });
});
