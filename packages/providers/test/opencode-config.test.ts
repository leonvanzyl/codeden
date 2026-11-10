import path from "node:path";
import { describe, expect, it } from "vitest";
import { formAnswer, questionOf } from "../src/opencode/approvals";
import { SseParser } from "../src/opencode/client";
import {
  mcpServerConfig,
  modelRef,
  openCodeConfig,
  openCodeVariant,
  toPromptBody,
} from "../src/opencode/config";
import { exeFromCmdShim, openCodeKnownLocations } from "../src/opencode/locate";
import { fallbackOpenCodeModels, openCodeModelList } from "../src/opencode/models";
import { guardPluginSource, HIDDEN_ENV_VARS } from "../src/opencode/plugin";
import { mergeConfig, openCodeServerEnv } from "../src/opencode/server";
import { TurnUsage } from "../src/opencode/usage";

describe("OpenCode config", () => {
  it("parses provider/model ids, keeping slashes in the model id", () => {
    expect(modelRef("anthropic/claude-opus-5-5", "high")).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
      variant: "high",
    });
    expect(modelRef("lmstudio/openai/gpt-oss-20b")).toEqual({
      providerID: "lmstudio",
      id: "openai/gpt-oss-20b",
    });
    expect(modelRef("default")).toBeUndefined();
    expect(modelRef("no-slash")).toBeUndefined();
    expect(modelRef(null)).toBeUndefined();
  });

  it("maps efforts onto the model's variants, falling back to the nearest", () => {
    expect(openCodeVariant("high", ["low", "high", "max"])).toBe("high");
    expect(openCodeVariant("xhigh", ["low", "high", "max"])).toBe("high");
    expect(openCodeVariant("minimal", ["medium", "high"])).toBe("medium");
    expect(openCodeVariant("high", [])).toBeUndefined();
    expect(openCodeVariant("high")).toBe("high");
    expect(openCodeVariant(undefined, ["low"])).toBeUndefined();
  });

  it("injects MCP servers directly (not behind code mode) with their headers", () => {
    const config = openCodeConfig({
      mcpServers: [
        {
          transport: "http",
          name: "codeden",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer t" },
        },
        { transport: "stdio", name: "my tools", command: "node", args: ["s.js"], env: { A: "1" } },
      ],
      pluginDir: "C:\\tmp\\codeden-opencode-x",
    });
    expect(config).toEqual({
      plugins: ["C:/tmp/codeden-opencode-x"],
      mcp: {
        servers: {
          codeden: {
            type: "remote",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer t" },
            oauth: false,
            codemode: false,
          },
          my_tools: {
            type: "local",
            command: ["node", "s.js"],
            environment: { A: "1" },
            codemode: false,
          },
        },
      },
    });
    expect(openCodeConfig({ mcpServers: [] })).toEqual({});
    expect(
      mcpServerConfig({ transport: "http", name: "x", url: "http://h/mcp", toolTimeoutSec: 30 }),
    ).toMatchObject({ timeout: 30_000 });
  });

  it("sends attachments as file and data URIs", () => {
    const body = toPromptBody({
      text: "look",
      attachments: [
        { type: "file", path: path.resolve("/w/a.ts"), name: "a.ts" },
        { type: "image", mediaType: "image/png", source: { type: "base64", data: "AAA" } },
      ],
    });
    expect(body.text).toBe("look");
    expect(body.files?.[0]?.uri).toMatch(/^file:\/\/\/.*a\.ts$/);
    expect(body.files?.[1]).toEqual({ uri: "data:image/png;base64,AAA" });
    expect(toPromptBody({ text: "x", attachments: [] }, "steer")).toEqual({
      text: "x",
      delivery: "steer",
    });
  });

  it("builds the server env: password and config in, secrets and Electron's flag out", () => {
    const env = openCodeServerEnv(
      {
        PATH: "/bin",
        ELECTRON_RUN_AS_NODE: "1",
        opencode_server_password: "old",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["user-plugin"], model: "x/y" }),
      },
      { EXTRA: "1" },
      "pw",
      { plugins: ["guard"], mcp: { servers: { codeden: { url: "u" } } } },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.EXTRA).toBe("1");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.opencode_server_password).toBeUndefined();
    expect(env.OPENCODE_PASSWORD).toBe("pw");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      plugins: ["user-plugin", "guard"],
      model: "x/y",
      mcp: { servers: { codeden: { url: "u" } } },
    });
    expect(mergeConfig({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  });

  it("the guard plugin removes the server's secrets from shell commands", async () => {
    const source = guardPluginSource();
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    let hook: ((e: { env: Record<string, string | undefined> }) => void) | undefined;
    await mod.default.setup({
      shell: {
        hook: async (_name: string, fn: typeof hook) => {
          hook = fn;
        },
      },
    });
    const event = {
      env: { OPENCODE_PASSWORD: "x", opencode_config_content: "{}", PATH: "/bin", OPENCODE: "1" },
    };
    hook?.(event);
    expect(event.env).toEqual({ PATH: "/bin", OPENCODE: "1" });
    expect(mod.default.id).toBe("codeden-env-guard");
    expect(HIDDEN_ENV_VARS).toContain("OPENCODE_SERVER_PASSWORD");
  });

  it("finds the native binary behind npm's .cmd shim and the installer folders", () => {
    const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n';
    expect(exeFromCmdShim("C:\\npm\\opencode.cmd", shim)).toBe(
      "C:\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe",
    );
    expect(exeFromCmdShim("C:\\npm\\x.cmd", '"%dp0%\\x.js" %*')).toBeUndefined();
    expect(
      openCodeKnownLocations("win32", "C:\\Users\\me", {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      }),
    ).toEqual([
      "C:\\Users\\me\\.opencode\\bin\\opencode.exe",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd",
    ]);
    expect(openCodeKnownLocations("darwin", "/Users/me", {})).toContain(
      "/Users/me/.opencode/bin/opencode",
    );
  });

  it("parses SSE across chunk boundaries", () => {
    const seen: string[] = [];
    const parser = new SseParser((d) => seen.push(d));
    parser.push('data: {"a"');
    parser.push(':1}\r\n\r\nevent: x\ndata: {"b":2}\n\n: comment\n\n');
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("OpenCode models", () => {
  it("lists usable models with provider names, efforts and the default first", () => {
    const list = openCodeModelList(
      [
        {
          id: "gpt-5.5",
          providerID: "openai",
          name: "GPT-5.5",
          variants: [{ id: "none" }, { id: "medium" }, { id: "max" }],
        },
        { id: "old", providerID: "openai", status: "deprecated" },
        { id: "nt", providerID: "openai", capabilities: { tools: false } },
        {
          id: "claude-opus-5-5",
          providerID: "anthropic",
          name: "Claude Opus 5.5",
          limit: { context: 200000 },
        },
        { id: "gpt-5.5", providerID: "openai" },
      ],
      [{ id: "openai", name: "OpenAI" }],
      { id: "claude-opus-5-5", providerID: "anthropic" },
    );
    expect(list).toEqual([
      {
        id: "anthropic/claude-opus-5-5",
        label: "Claude Opus 5.5",
        description: "anthropic",
        efforts: [],
        isDefault: true,
        contextWindow: 200000,
      },
      { id: "openai/gpt-5.5", label: "GPT-5.5", description: "OpenAI", efforts: ["medium", "max"] },
    ]);
    expect(fallbackOpenCodeModels("down")[0]).toMatchObject({ id: "default", isDefault: true });
  });

  it("sums a turn's usage; reasoning counts as output; zero cost is left out", () => {
    const usage = new TurnUsage(1000);
    const t = { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } };
    usage.add(t, 0);
    expect(usage.snapshot()).not.toHaveProperty("costUsd");
    usage.add(t, 0.01, false);
    expect(usage.snapshot()).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cachedInputTokens: 20,
      cacheWriteTokens: 4,
      reasoningTokens: 10,
      contextTokens: 137,
      contextWindow: 1000,
      costUsd: 0.01,
    });
  });
});

describe("OpenCode forms", () => {
  const form = { id: "f", sessionID: "s", title: "Questions", fields: [] };
  it("maps fields to questions and answers back to values", () => {
    expect(questionOf({ key: "ok", type: "boolean", title: "Proceed?" }, form, 1)).toMatchObject({
      id: "ok",
      options: [{ label: "Yes" }, { label: "No" }],
      allowFreeText: false,
    });
    expect(
      questionOf({ key: "n", type: "integer", description: "How many?" }, form, 2),
    ).toMatchObject({
      question: "How many?",
      allowFreeText: true,
    });
    const fields = [
      { key: "ok", type: "boolean" as const },
      { key: "n", type: "integer" as const },
      { key: "c", type: "string" as const, options: [{ value: "r", label: "Red" }] },
      { key: "free", type: "string" as const },
    ];
    expect(
      formAnswer(fields, {
        kind: "answer",
        answers: { ok: ["Yes"], n: ["3.4"], c: ["Red"], free: ["hi"] },
      }),
    ).toEqual({ ok: true, n: 3, c: "r", free: "hi" });
  });
});
