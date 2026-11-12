import { ProviderInfo } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { getProvider, listProviders, providerInfo } from "../src";

describe("provider registry", () => {
  it("lists the built-in providers with honest capabilities", () => {
    expect(listProviders().map((p) => p.id)).toEqual(["claude", "codex"]);
    const claude = getProvider("claude");
    const codex = getProvider("codex");
    expect(claude?.capabilities()).toMatchObject({ subagents: true, planMode: true, steer: true });
    expect(codex?.capabilities()).toMatchObject({ subagents: true, planMode: false, steer: true });
    for (const p of listProviders()) {
      ProviderInfo.parse(providerInfo(p));
      expect(p.utilityModel?.().providerId).toBe(p.id);
    }
    expect(getProvider("nope")).toBeUndefined();
  });
});
