import { describe, expect, it } from "vitest";
import {
  AutonomyLevel,
  CODEDEN_CREDENTIAL_FILES,
  ProviderCapabilities,
  SessionOptions,
} from "../src";

describe("permission levels (§11.2)", () => {
  it("adds read_only below the existing levels, keeping the old ones valid", () => {
    expect(AutonomyLevel.options).toEqual(["read_only", "supervised", "auto", "full"]);
    for (const level of AutonomyLevel.options) {
      expect(AutonomyLevel.parse(JSON.parse(JSON.stringify(level)))).toBe(level);
    }
    expect(AutonomyLevel.safeParse("readonly").success).toBe(false);
  });

  it("round-trips session options at read_only", () => {
    const opts = SessionOptions.parse({
      sessionId: "s1",
      role: "agent",
      cwd: "/repo",
      autonomy: "read_only",
    });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
  });

  it("round-trips the session's own branch, and leaves it out by default", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "auto" } as const;
    expect(SessionOptions.parse(base).ownBranch).toBeUndefined();
    const opts = SessionOptions.parse({ ...base, ownBranch: "codeden/fix-login-ab12" });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
    expect(opts.ownBranch).toBe("codeden/fix-login-ab12");
    expect(SessionOptions.safeParse({ ...base, ownBranch: "" }).success).toBe(false);
  });

  it("round-trips CodeDen's home for the credential-file rule, and leaves it out by default", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "full" } as const;
    expect(SessionOptions.parse(base).codedenHome).toBeUndefined();
    const opts = SessionOptions.parse({ ...base, codedenHome: "/home/me/.codeden" });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
    expect(opts.codedenHome).toBe("/home/me/.codeden");
    expect(SessionOptions.safeParse({ ...base, codedenHome: "" }).success).toBe(false);
    expect(CODEDEN_CREDENTIAL_FILES).toEqual([
      "install-token",
      "runner/runner.json",
      "remote-access.json",
    ]);
  });

  it("treats the readOnly capability as optional", () => {
    const caps = {
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
    };
    expect(ProviderCapabilities.parse(caps).readOnly).toBeUndefined();
    const withFlag = ProviderCapabilities.parse({ ...caps, readOnly: true });
    expect(ProviderCapabilities.parse(JSON.parse(JSON.stringify(withFlag)))).toEqual(withFlag);
  });
});
