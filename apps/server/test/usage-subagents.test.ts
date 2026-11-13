import type { ModelPrice, SubagentModelUsage } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { priceSubagent } from "../src/services/usage/subagents";

const million = (extra: Partial<SubagentModelUsage> = {}): SubagentModelUsage => ({
  inputTokens: 1e6,
  outputTokens: 1e6,
  cacheReadTokens: 1e6,
  cacheWriteTokens: 1e6,
  ...extra,
});

const claudeSession = { provider: "claude", model: "claude-sonnet-4-5" };

describe("subagent cost", () => {
  it("prices each model from the table, the session's model when the run named none", () => {
    const cost = priceSubagent(
      "a1",
      [million({ model: "claude-haiku-5-5", reasoningTokens: 7 }), million()],
      claudeSession,
    );
    // Haiku 5.5: $0.10 + $0.50 + $0.01 + $0.125; Sonnet 4.5: $3 + $15 + $0.30 + $3.75.
    expect(cost).toEqual({
      itemId: "a1",
      costUsd: 22.785,
      costSource: "estimated",
      models: [
        {
          model: "claude-haiku-5-5",
          label: "Haiku 5.5",
          inputTokens: 1e6,
          outputTokens: 1e6,
          cacheReadTokens: 1e6,
          cacheWriteTokens: 1e6,
          reasoningTokens: 7,
          costUsd: 0.735,
          costSource: "estimated",
        },
        expect.objectContaining({
          model: "claude-sonnet-4-5",
          label: "Sonnet 4.5",
          reasoningTokens: 0,
          costUsd: 22.05,
          costSource: "estimated",
        }),
      ],
    });
  });

  it("labels costs like turns: reported, estimated or not priced", () => {
    const reported = priceSubagent(
      "a1",
      [million({ costUsd: 0.4 }), million({ model: "x", costUsd: 0.1 })],
      { provider: "opencode", model: "anthropic/claude-opus-5-5" },
    );
    expect(reported).toMatchObject({ costUsd: 0.5, costSource: "reported" });

    // A zero reported with tokens is no figure: the tokens are priced instead.
    const zero = priceSubagent(
      "a1",
      [million({ model: "claude-haiku-5-5", costUsd: 0 })],
      claudeSession,
    );
    expect(zero).toMatchObject({ costUsd: 0.735, costSource: "estimated" });

    // One model has no price: the run's cost is what could be priced, as an estimate.
    const partly = priceSubagent(
      "a1",
      [million({ model: "claude-haiku-5-5" }), million({ model: "mystery-model" })],
      claudeSession,
    );
    expect(partly.costSource).toBe("estimated");
    expect(partly.costUsd).toBeCloseTo(0.735, 9);
    expect(partly.models[1]).toMatchObject({ costUsd: 0, costSource: "unpriced" });
    expect(partly.models[1]).not.toHaveProperty("label");

    const none = priceSubagent("a1", [million()], { provider: "fake", model: null });
    expect(none).toMatchObject({
      costUsd: 0,
      costSource: "unpriced",
      models: [{ model: "default", costSource: "unpriced" }],
    });
  });

  it("uses the user's prices first", () => {
    const override: ModelPrice = {
      provider: "codex",
      model: "gpt-5.2",
      label: "Team rate",
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheReadPerMTok: 1,
      cacheWritePerMTok: 1,
      asOf: "2026-11-13",
    };
    const cost = priceSubagent("c1", [million({ model: "gpt-5.2" })], {
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    expect(cost.costUsd).toBeCloseTo(1.75 + 14 + 0.175, 9);
    const mine = priceSubagent(
      "c1",
      [million({ model: "gpt-5.2" })],
      { provider: "codex", model: "gpt-6.1-sol" },
      [override],
    );
    expect(mine).toMatchObject({ costUsd: 4, models: [{ label: "Team rate" }] });
  });
});
