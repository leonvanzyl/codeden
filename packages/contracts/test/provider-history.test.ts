import { describe, expect, it } from "vitest";
import {
  HideProviderHistoryRequest,
  HideProviderHistoryResponse,
  PROVIDER_HISTORY_MAX,
  ProviderCapabilities,
  ProviderHistoryResponse,
  RunnerCommand,
  RunnerCommandResults,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const entry = {
  resumeToken: "019a-thread",
  preview: "You are the independent reviewer of pull request #12.",
  updatedAt: "2026-11-14T10:00:00.000Z",
};

describe("provider history contracts", () => {
  it("round-trips the runner commands and their results", () => {
    for (const name of ["provider.history.list", "provider.history.hide"] as const) {
      roundTrip(RunnerCommand, { name, providerId: "codex", resumeTokens: ["019a-thread"] });
    }
    roundTrip(RunnerCommandResults["provider.history.list"], { entries: [entry] });
    roundTrip(RunnerCommandResults["provider.history.hide"], {
      hidden: ["a"],
      missing: ["b"],
      failed: [{ resumeToken: "c", message: "busy" }],
    });
  });

  it("bounds how many conversations one command names", () => {
    const tokens = Array.from({ length: PROVIDER_HISTORY_MAX + 1 }, (_, i) => `t-${i}`);
    expect(
      RunnerCommand.safeParse({
        name: "provider.history.hide",
        providerId: "codex",
        resumeTokens: tokens,
      }).success,
    ).toBe(false);
  });

  it("round-trips the API, and hiding needs confirm: true", () => {
    roundTrip(ProviderHistoryResponse, {
      providerId: "codex",
      recorded: 3,
      entries: [{ ...entry, sessionId: "s1", sessionTitle: null }],
    });
    roundTrip(HideProviderHistoryResponse, {
      providerId: "codex",
      hidden: ["a"],
      missing: [],
      failed: [],
    });
    expect(HideProviderHistoryRequest.parse({ confirm: true })).toEqual({ confirm: true });
    for (const body of [{}, { confirm: false }, { confirm: "true" }]) {
      expect(HideProviderHistoryRequest.safeParse(body).success).toBe(false);
    }
  });

  it("keeps vendorHistory optional on capabilities", () => {
    const base = ProviderCapabilities.parse({
      resume: true,
      steer: false,
      interrupt: true,
      approvals: true,
      userQuestions: false,
      subagents: false,
      rollback: false,
      fork: false,
      images: false,
      planMode: false,
      reasoningEffort: false,
      mcp: true,
      skills: false,
    });
    expect(base.vendorHistory).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...base, vendorHistory: true }).vendorHistory).toBe(
      true,
    );
  });
});
