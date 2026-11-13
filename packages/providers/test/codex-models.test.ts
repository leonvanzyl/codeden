import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/adapter";
import { CodexAdapter } from "../src/codex/adapter";
import { listCodexModels, modelInfoFromCodex, visibleCodexModels } from "../src/codex/models";
import type { Model } from "../src/codex/protocol/v2";
import { ModelCatalog } from "../src/models";
import { ProviderRegistry } from "../src/registry";

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

let log: string;
beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), "codeden-codex-models-")), "requests.log");
  process.env.FAKE_CODEX_LOG = log;
});
afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_MODEL_LIST;
});

/** Requests the fake app-server received. */
function requests(): Array<{ method: string; params: Record<string, unknown> | undefined }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const PAGED: ModelInfo[] = [
  {
    id: "gpt-sol",
    label: "GPT-SOL",
    description: "gpt-sol description",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "low",
    isDefault: true,
  },
  {
    id: "gpt-luna",
    label: "GPT-LUNA",
    description: "gpt-luna description",
    efforts: ["low", "medium"],
    defaultEffort: "medium",
  },
];

describe("Codex model mapping", () => {
  it("uses the model slug as id, keeps known efforts and drops hidden models", () => {
    const models = [
      {
        id: "internal-id",
        model: "gpt-sol",
        displayName: "GPT Sol",
        description: "",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "max", description: "" },
          { reasoningEffort: "ultra", description: "" },
        ],
        defaultReasoningEffort: "ultra",
        isDefault: true,
      },
      { model: "gpt-hidden", displayName: "Hidden", hidden: true },
    ] as unknown as Model[];
    expect(visibleCodexModels(models)).toEqual([
      { id: "gpt-sol", label: "GPT Sol", efforts: ["max"], isDefault: true },
    ]);
  });

  it("tolerates models from older app-servers without efforts", () => {
    const bare = { model: "gpt-old", displayName: "", isDefault: false } as unknown as Model;
    expect(modelInfoFromCodex(bare)).toEqual({ id: "gpt-old", label: "gpt-old", efforts: [] });
  });
});

describe("listCodexModels", () => {
  it("reads every page of model/list without starting a thread or a turn", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "paged";
    expect(await listCodexModels(fakeCodex)).toEqual(PAGED);
    const sent = requests();
    expect(sent.map((r) => r.method)).toEqual(["initialize", "model/list", "model/list"]);
    expect(sent.map((r) => r.params?.cursor)).toEqual([undefined, undefined, "page-2"]);
  });

  it("rejects when Codex answers with an error", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "error";
    await expect(listCodexModels(fakeCodex)).rejects.toThrow(/no models/);
  });

  it("gives up on an app-server that never answers", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "hang";
    const started = Date.now();
    await expect(listCodexModels(fakeCodex, { timeoutMs: 300 })).rejects.toThrow(/within 300ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("CodexAdapter model discovery", () => {
  it("replaces the Default fallback with Codex's list and reports the change once", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "paged";
    const adapter = new CodexAdapter({ executable: fakeCodex });
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
    let changes = 0;
    adapter.onModelsChanged(() => changes++);

    // Concurrent refreshes share one app-server.
    await Promise.all([adapter.refreshModels(), adapter.refreshModels()]);
    expect(adapter.models()).toEqual(PAGED);
    expect(changes).toBe(1);
    expect(requests().filter((r) => r.method === "initialize")).toHaveLength(1);

    // The same list again is not a change.
    await adapter.refreshModels();
    expect(changes).toBe(1);
  });

  it("keeps an honest Default when discovery fails, and never throws", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "error";
    const adapter = new CodexAdapter({ executable: fakeCodex });
    await expect(adapter.refreshModels()).resolves.toBeUndefined();
    const [fallback, ...rest] = adapter.models();
    expect(rest).toEqual([]);
    expect(fallback).toMatchObject({ id: "default", isDefault: true });
    expect(fallback?.description).toMatch(/could not be loaded: no models/);
  });

  it("skips a refresh with maxAgeMs while the list is recent", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "paged";
    const adapter = new CodexAdapter({ executable: fakeCodex });
    const starts = () => requests().filter((r) => r.method === "initialize").length;
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(starts()).toBe(1);
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(starts()).toBe(1);
    await adapter.refreshModels({ maxAgeMs: 0 });
    expect(starts()).toBe(2);
  });

  it("keeps the last real list when a later discovery fails", async () => {
    process.env.FAKE_CODEX_MODEL_LIST = "paged";
    // A busy machine can take seconds to start the fake app-server: only the hanging
    // discovery gets the short deadline (the adapter reads its options on every discovery).
    const options = { executable: fakeCodex, modelListTimeoutMs: 30_000 };
    const adapter = new CodexAdapter(options);
    await adapter.refreshModels();
    expect(adapter.models()).toEqual(PAGED);
    process.env.FAKE_CODEX_MODEL_LIST = "hang";
    options.modelListTimeoutMs = 300;
    await adapter.refreshModels();
    expect(adapter.models()).toEqual(PAGED);
  });

  it("skips discovery when Codex is not installed", async () => {
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    const empty = mkdtempSync(join(tmpdir(), "codeden-empty-path-"));
    process.env.PATH = empty;
    if (process.platform === "win32") process.env.Path = empty;
    try {
      const adapter = new CodexAdapter();
      await adapter.refreshModels();
      expect(adapter.models()).toMatchObject([
        { id: "default", description: "The model configured in ~/.codex/config.toml" },
      ]);
    } finally {
      process.env.PATH = saved.PATH;
      if (process.platform === "win32") process.env.Path = saved.Path;
    }
  });

  it("reports the models a session lists", async () => {
    const adapter = new CodexAdapter({ executable: fakeCodex });
    const changed = new Promise<void>((resolve) => adapter.onModelsChanged(resolve));
    const options: SessionOptions = {
      sessionId: "s1",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
    };
    const session = await adapter.openSession(options);
    try {
      await changed;
      expect(adapter.models().map((m) => [m.id, m.isDefault ?? false])).toEqual([
        ["gpt-other", false],
        ["gpt-configured", true],
      ]);
    } finally {
      await session.close();
    }
  });
});

describe("ModelCatalog", () => {
  it("hands out copies and notifies only on real changes", () => {
    const catalog = new ModelCatalog([{ id: "a", label: "A", efforts: ["low"] }]);
    let calls = 0;
    const off = catalog.subscribe(() => calls++);
    catalog.subscribe(() => {
      throw new Error("a broken listener");
    });
    catalog.list()[0]?.efforts.push("high");
    expect(catalog.set([{ id: "a", label: "A", efforts: ["low"] }])).toBe(false);
    expect(catalog.set([{ id: "b", label: "B", efforts: [] }])).toBe(true);
    expect(calls).toBe(1);
    off();
    catalog.set([]);
    expect(calls).toBe(1);
  });
});

describe("ProviderRegistry model refresh", () => {
  function scripted(id: string, next: ModelInfo[] | Error) {
    const catalog = new ModelCatalog([]);
    const refreshed: string[] = [];
    const adapter = {
      id,
      displayName: id,
      detect: async () => ({}) as never,
      capabilities: () => ({}) as never,
      models: () => catalog.list(),
      onModelsChanged: (l: () => void) => catalog.subscribe(l),
      refreshModels: async () => {
        refreshed.push(id);
        if (next instanceof Error) throw next;
        catalog.set(next);
      },
      openSession: async () => {
        throw new Error("not used");
      },
    } satisfies ProviderAdapter;
    return { adapter, refreshed };
  }

  it("refreshes the requested adapters and announces changes", async () => {
    const a = scripted("a", [{ id: "a-1", label: "A1", efforts: [] }]);
    const b = scripted("b", new Error("adapters must not throw, but one did"));
    const registry = new ProviderRegistry([a.adapter, b.adapter]);
    let changes = 0;
    registry.onChange(() => changes++);

    await registry.refreshModels(["b"]);
    expect([a.refreshed, b.refreshed]).toEqual([[], ["b"]]);
    expect(changes).toBe(0);

    await registry.refreshModels();
    expect(a.refreshed).toEqual(["a"]);
    expect(changes).toBe(1);
    expect(
      registry
        .info()
        .find((p) => p.id === "a")
        ?.models.map((m) => m.id),
    ).toEqual(["a-1"]);
  });
});
