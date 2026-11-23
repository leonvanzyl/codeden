import { describe, expect, it } from "vitest";
import { classifyOpenCodeError, failure } from "../src/opencode/errors";

const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const err = (type: string, message: string, status?: number, retryAfterMs?: number) => ({
  type,
  message,
  ...(status ? { status } : {}),
  ...(retryAfterMs ? { retryAfterMs } : {}),
});

describe("OpenCode turn errors", () => {
  it("classifies what a retry could fix and what needs the user", () => {
    expect(classifyOpenCodeError(err("provider.auth", "Invalid API key", 401), NOW)).toEqual({
      kind: "auth",
    });
    expect(
      classifyOpenCodeError(err("api", "You exceeded your current quota", 429, 3_600_000), NOW),
    ).toEqual({ kind: "usage_limit", retryAt: "2026-11-11T09:00:00.000Z" });
    expect(classifyOpenCodeError(err("api", "Rate limit reached", 429), NOW)).toEqual({
      kind: "transient",
    });
    expect(classifyOpenCodeError(err("api", "Overloaded", 529), NOW).kind).toBe("transient");
    expect(classifyOpenCodeError(err("unknown", "socket hang up"), NOW).kind).toBe("transient");
    expect(
      classifyOpenCodeError(err("api", "prompt is too long: 210000 tokens > 200000", 400), NOW)
        .kind,
    ).toBe("context_full");
    expect(classifyOpenCodeError(err("tool.execution", "Invalid arguments"), NOW).kind).toBe(
      "fatal",
    );
    expect(classifyOpenCodeError(undefined, NOW).kind).toBe("fatal");
  });

  // Issue #585: "Model unavailable" matched the transient pattern, so CodeDen retried a model
  // the session's folder doesn't have, and it said nothing about why.
  it("treats a model OpenCode can't route as a setup problem and says where to fix it", () => {
    const noRoute = err("provider.no-route", "Model unavailable: 9router/Worker");
    expect(classifyOpenCodeError(noRoute, NOW)).toEqual({ kind: "fatal" });
    const outcome = failure(noRoute);
    expect(outcome).toMatchObject({ type: "failed", code: "opencode_provider_no_route" });
    expect(outcome.type === "failed" && outcome.message).toMatch(
      /^Model unavailable: 9router\/Worker\. .*global OpenCode config/,
    );
    // OpenCode's own advice is kept as it is.
    const deprecated =
      "Model unavailable: azure-cognitive-services/gpt. This provider has been deprecated; use azure/gpt instead.";
    expect(failure(err("provider.no-route", deprecated))).toMatchObject({ message: deprecated });
  });

  // Issue #218: an expired OpenAI login behind an `openai/*` model fails the turn with only the
  // status in the message, and the factory kept starting reviewers on OpenCode.
  it("classifies a 401 or 403 that is only in the message as a sign-in problem", () => {
    expect(classifyOpenCodeError(err("unknown", "Request failed: 401"), NOW)).toEqual({
      kind: "auth",
    });
    expect(classifyOpenCodeError(err("unknown", "Request failed: 403"), NOW)).toEqual({
      kind: "auth",
    });
    // Other statuses in the message count like the field; a stray number is not a status.
    expect(classifyOpenCodeError(err("unknown", "Request failed: 503"), NOW).kind).toBe(
      "transient",
    );
    expect(classifyOpenCodeError(err("tool.execution", "No line 401 in file"), NOW).kind).toBe(
      "fatal",
    );
  });
});
