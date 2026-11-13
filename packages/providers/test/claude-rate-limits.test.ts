import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSession } from "../src/claude/session";
import { usageFromPlanUsage, usageFromRateLimit } from "../src/claude/usage";

/** The SDK's plan usage answer for a subscription login (`get_usage`, rate limits only). */
const PLAN_USAGE = {
  session: {},
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: "2026-11-13T18:00:00.000Z" },
    seven_day: { utilization: 37, resets_at: "2026-11-17T06:00:00.000Z" },
    seven_day_opus: { utilization: 5, resets_at: "2026-11-17T06:00:00.000Z" },
    seven_day_sonnet: null,
  },
  behaviors: null,
};

/**
 * A stand-in for the SDK's `query()`: yields `messages`, then stays open until the session
 * closes. Counts plan usage reads.
 */
function stubSdk(messages: unknown[] = []) {
  const reads: unknown[] = [];
  const query = (() => {
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = [...messages];
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const value = queue.shift();
          if (value) return { done: false as const, value };
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      interrupt: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts: unknown) => {
        reads.push(opts);
        return PLAN_USAGE;
      },
      close: () => finish(),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return { query, reads };
}

function open(sdk: ReturnType<typeof stubSdk>) {
  const events: AgentEvent[] = [];
  const session = new ClaudeSession(base, {
    executable: { kind: "native", path: "/bin/claude" } as never,
    query: sdk.query,
  });
  sessions.push(session);
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  return events;
}

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: import.meta.dirname,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const event = (info: Record<string, unknown>) =>
  usageFromRateLimit({ type: "rate_limit_event", rate_limit_info: info })?.rateLimits?.[0];

describe("rate_limit_event mapping", () => {
  it("maps a status-only event without a percentage", () => {
    // What the SDK usually sends: no `utilization`, so the event alone cannot fill the bar.
    expect(
      usageFromRateLimit({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "seven_day", resetsAt: 1794895200 },
      }),
    ).toEqual({
      rateLimits: [{ id: "weekly", status: "ok", resetsAt: "2026-11-17T06:00:00.000Z" }],
    });
  });

  it("reads utilization given as a 0–1 fraction or a 0–100 percentage", () => {
    const at = { status: "allowed", rateLimitType: "seven_day" };
    expect(event({ ...at, utilization: 0.42 })?.usedPercent).toBe(42);
    expect(event({ ...at, utilization: 42 })?.usedPercent).toBe(42);
    expect(event({ ...at, utilization: 0 })?.usedPercent).toBe(0);
    expect(event({ ...at, utilization: 130 })?.usedPercent).toBe(100);
  });

  it("names each window type", () => {
    const ids = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"].map(
      (rateLimitType) => event({ status: "allowed", rateLimitType })?.id,
    );
    expect(ids).toEqual(["5h", "weekly", "weekly-opus", "weekly-sonnet"]);
    expect(event({ status: "allowed", rateLimitType: "overage" })?.id).toBe("overage");
  });

  it("maps warning and rejected statuses", () => {
    expect(event({ status: "allowed_warning", rateLimitType: "five_hour" })?.status).toBe(
      "warning",
    );
    expect(event({ status: "rejected", rateLimitType: "five_hour" })?.status).toBe("limited");
  });
});

describe("plan usage mapping", () => {
  it("maps every window with a figure, including per-model weekly ones", () => {
    expect(
      usageFromPlanUsage({
        ...PLAN_USAGE,
        rate_limits: {
          ...PLAN_USAGE.rate_limits,
          seven_day: { utilization: 100, resets_at: "2026-11-17T06:00:00.123456+00:00" },
          seven_day_sonnet: { utilization: null, resets_at: null },
          model_scoped: [{ display_name: "Haiku", utilization: 0.4, resets_at: null }],
        },
      }),
    ).toEqual({
      rateLimits: [
        { id: "5h", status: "ok", usedPercent: 12, resetsAt: "2026-11-13T18:00:00.000Z" },
        { id: "weekly", status: "limited", usedPercent: 100, resetsAt: "2026-11-17T06:00:00.123Z" },
        { id: "weekly-opus", status: "ok", usedPercent: 5, resetsAt: "2026-11-17T06:00:00.000Z" },
        // Plan usage is already 0–100: 0.4 means 0.4%, not 40%.
        { id: "weekly-haiku", status: "ok", usedPercent: 0.4 },
      ],
    });
  });

  it("reports nothing when plan limits do not apply", () => {
    expect(
      usageFromPlanUsage({ ...PLAN_USAGE, rate_limits_available: false, rate_limits: null }),
    ).toBeUndefined();
    expect(usageFromPlanUsage(undefined)).toBeUndefined();
  });
});

describe("Claude subscription limits (#193)", () => {
  it("reads every plan window's percentage from the SDK when the session starts", async () => {
    const sdk = stubSdk();
    const events = open(sdk);
    await vi.waitFor(
      () => {
        const limits = events.flatMap((e) =>
          e.type === "usage.updated" ? (e.usage.rateLimits ?? []) : [],
        );
        expect(limits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "5h", usedPercent: 12 }),
            expect.objectContaining({ id: "weekly", usedPercent: 37 }),
            expect.objectContaining({ id: "weekly-opus", usedPercent: 5 }),
          ]),
        );
      },
      { timeout: 500 },
    );
    // Only the rate limits: the transcript scan behind `/usage`'s behaviors is skipped.
    expect(sdk.reads).toEqual([{ skipBehaviors: true }]);
  });

  it("reads the plan usage again after each turn", async () => {
    const sdk = stubSdk([{ type: "result", subtype: "success", modelUsage: {} }]);
    open(sdk);
    await vi.waitFor(() => expect(sdk.reads).toHaveLength(2), { timeout: 500 });
  });
});
