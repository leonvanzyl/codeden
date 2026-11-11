import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/opencode/adapter";
import { authFromProbe, detectOpenCode } from "../src/opencode/detect";
import { cheapUtilityModel } from "../src/opencode/models";
import { probeOpenCode } from "../src/opencode/probe";

const fake = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-opencode", "opencode.mjs"),
};

afterEach(() => {
  delete process.env.FAKE_OPENCODE_MODE;
});

describe("OpenCode detection", () => {
  it("reports a missing install with the install command", async () => {
    const status = await detectOpenCode({ locate: { pathEnv: "", knownLocations: [] } });
    expect(status).toMatchObject({ providerId: "opencode", installed: false, loggedIn: null });
    expect(status.issues[0]).toMatchObject({
      code: "not_installed",
      fix: { kind: "install", command: "npm install -g @opencode/cli" },
    });
    const broken = await detectOpenCode({
      executable: { kind: "native", path: join(tmpdir(), "no-such-opencode") },
    });
    expect(broken.installed).toBe(false);
    expect(broken.issues[0]).toMatchObject({ code: "broken_install" });
    expect(broken.broken?.[0]?.path).toContain("no-such-opencode");
  });

  it("detects version, providers and credentials through a probe", async () => {
    const status = await detectOpenCode({ executable: fake, probe: (exe) => probeOpenCode(exe) });
    expect(status).toMatchObject({
      installed: true,
      version: "2.2.7",
      supported: true,
      loggedIn: true,
      authMethod: "credentials",
      account: "anthropic",
      issues: [],
    });
  });

  it("asks for a provider when none is configured", async () => {
    process.env.FAKE_OPENCODE_MODE = "no-providers";
    const status = await detectOpenCode({ executable: fake, probe: (exe) => probeOpenCode(exe) });
    expect(status.loggedIn).toBe(false);
    expect(status.issues[0]).toMatchObject({
      code: "not_logged_in",
      fix: { kind: "login", command: "opencode auth login" },
    });
  });

  it("rejects OpenCode 1 with an install fix for OpenCode 2", async () => {
    process.env.FAKE_OPENCODE_MODE = "v1";
    const status = await detectOpenCode({ executable: fake });
    expect(status).toMatchObject({ installed: true, version: "1.19.5", supported: false });
    expect(status.issues[0]).toMatchObject({
      code: "version_unsupported",
      fix: { kind: "install", command: "npm install -g @opencode/cli" },
    });
  });

  it("reports a probe failure honestly instead of guessing", async () => {
    const status = await detectOpenCode({
      executable: fake,
      probe: async () => {
        throw new Error("server down");
      },
    });
    expect(status.loggedIn).toBeNull();
    expect(status.issues[0]).toMatchObject({ code: "detect_failed" });
    expect(status.issues[0]?.message).toContain("server down");
  });

  it("classifies how OpenCode is signed in", () => {
    expect(authFromProbe({ connected: ["openai"], providers: [] })).toMatchObject({
      authMethod: "credentials",
    });
    expect(authFromProbe({ connected: [], providers: [{ id: "anthropic" }] })).toMatchObject({
      loggedIn: true,
      authMethod: "environment",
    });
    expect(authFromProbe({ connected: [], providers: [{ id: "opencode" }] })).toMatchObject({
      loggedIn: true,
      authMethod: "free",
    });
    expect(authFromProbe({ connected: [], providers: [] }).loggedIn).toBe(false);
  });
});

describe("OpenCode model discovery", () => {
  it("lists models without a session, and skips a fresh list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-opencode-models-"));
    const log = join(dir, "log");
    writeFileSync(log, "");
    process.env.FAKE_OPENCODE_LOG = log;
    try {
      const adapter = new OpenCodeAdapter({ executable: fake });
      let changes = 0;
      adapter.onModelsChanged(() => changes++);
      await adapter.refreshModels();
      expect(adapter.models().map((m) => m.id)).toEqual([
        "anthropic/claude-opus-5-5",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-5.5",
        "lmstudio/openai/gpt-oss-20b",
      ]);
      expect(adapter.models()[0]).toMatchObject({
        isDefault: true,
        efforts: ["low", "high", "max"],
      });
      expect(changes).toBe(1);
      await adapter.refreshModels({ maxAgeMs: 60_000 });
      const { readFileSync } = await import("node:fs");
      const starts = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.includes('"start"'));
      expect(starts).toHaveLength(1);
      expect(readFileSync(log, "utf8")).not.toContain("/api/session");
    } finally {
      delete process.env.FAKE_OPENCODE_LOG;
    }
  });

  it("keeps an honest fallback when the list cannot be loaded", async () => {
    process.env.FAKE_OPENCODE_MODE = "models-error";
    const adapter = new OpenCodeAdapter({ executable: fake });
    await adapter.refreshModels();
    expect(adapter.models()).toHaveLength(1);
    expect(adapter.models()[0]).toMatchObject({ id: "default", isDefault: true });
    expect(adapter.models()[0]?.description).toContain("could not be loaded");
  });

  it("gives up on a server that never starts", async () => {
    process.env.FAKE_OPENCODE_MODE = "hang";
    const adapter = new OpenCodeAdapter({ executable: fake, probeTimeoutMs: 800 });
    const started = Date.now();
    await adapter.refreshModels();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(adapter.models()[0]?.description).toContain("could not be loaded");
  });

  it("picks the cheapest model from the default's provider for utility jobs", () => {
    const cost = (input: number, output: number, tier?: number) => ({
      ...(tier ? { tier: { type: "context", size: tier } } : {}),
      input,
      output,
    });
    const opus = { id: "opus", providerID: "anthropic", cost: [cost(5, 25)] };
    const haiku = {
      id: "haiku",
      providerID: "anthropic",
      // The context tier is not the base price, even when it comes first.
      cost: [cost(0.01, 0.01, 200_000), cost(1, 5)],
    };
    const models = [
      opus,
      haiku,
      { id: "cheaper-elsewhere", providerID: "openai", cost: [cost(0.05, 0.4)] },
      { id: "retired", providerID: "anthropic", status: "deprecated", cost: [cost(0.1, 0.1)] },
      { id: "off", providerID: "anthropic", enabled: false, cost: [cost(0.1, 0.1)] },
      { id: "unpriced", providerID: "anthropic" },
    ];
    expect(cheapUtilityModel(models, opus)).toEqual({ providerID: "anthropic", id: "haiku" });
    // The default wins a tie, and stays when nothing on its provider is cheaper.
    const twin = { id: "twin", providerID: "anthropic", cost: [cost(1, 5)] };
    expect(cheapUtilityModel([twin, haiku], haiku)).toEqual({
      providerID: "anthropic",
      id: "haiku",
    });
    expect(cheapUtilityModel(models, models[2])).toEqual({
      providerID: "openai",
      id: "cheaper-elsewhere",
    });
    // Nothing known: OpenCode's own default.
    expect(cheapUtilityModel(models, null)).toBeUndefined();
    expect(
      cheapUtilityModel([{ id: "a", providerID: "x" }], { id: "b", providerID: "x" }),
    ).toBeUndefined();
  });

  it("declares honest capabilities", () => {
    const caps = new OpenCodeAdapter({ executable: fake }).capabilities();
    expect(caps).toMatchObject({
      resume: true,
      steer: true,
      interrupt: true,
      approvals: true,
      userQuestions: true,
      subagents: true,
      mcp: true,
      liveAutonomy: true,
      readOnly: true,
      rollback: false,
      fork: false,
      planMode: false,
    });
  });
});
