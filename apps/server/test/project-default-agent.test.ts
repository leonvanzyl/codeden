import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { defaultAgent } from "../src/services/projects/project-service";

// #261: a project's default agent for new sessions (provider, model, effort).
describe("A project's default agent after an update", () => {
  const opus = { defaultProvider: "claude", defaultModel: "opus", defaultEffort: "high" } as const;
  const none = { defaultProvider: null, defaultModel: null, defaultEffort: null };

  it("sets and clears provider, model and effort together", () => {
    expect(defaultAgent(none, opus)).toEqual(opus);
    expect(defaultAgent(opus, none)).toEqual(none);
  });

  it("keeps the model and effort when the update doesn't touch the provider", () => {
    expect(defaultAgent(opus, {})).toEqual(opus);
    expect(defaultAgent(opus, { defaultProvider: "claude" })).toEqual(opus);
    expect(defaultAgent(opus, { defaultEffort: "low" })).toEqual({ ...opus, defaultEffort: "low" });
  });

  it("clears the model and effort when only the provider changes: they belong to the old one", () => {
    expect(defaultAgent(opus, { defaultProvider: "codex" })).toEqual({
      defaultProvider: "codex",
      defaultModel: null,
      defaultEffort: null,
    });
    expect(defaultAgent(opus, { defaultProvider: null })).toEqual(none);
  });

  it("refuses a model or effort without a default provider", () => {
    expect(() => defaultAgent(none, { defaultModel: "opus" })).toThrow(ServiceError);
    expect(() => defaultAgent(none, { defaultEffort: "high" })).toThrow(/needs a default provider/);
    expect(() => defaultAgent(opus, { defaultProvider: null, defaultModel: "opus" })).toThrow(
      ServiceError,
    );
  });
});
