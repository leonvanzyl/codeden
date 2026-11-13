import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ModelInfo,
  type ProviderInfo,
  type ProviderStatus,
  RefreshModelsResponse,
  ServerToClientMessage,
  Snapshot,
} from "@codeden/contracts";
import { FakeProvider, ModelCatalog, type ProviderAdapter } from "@codeden/providers";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RunningServer, startServer } from "../src";
import type { Exec } from "../src/services/exec";
import {
  type RunnerPort,
  redetectProviders,
  refreshProviderModels,
} from "../src/services/runner-port";
import { RUNNER_REQUEST_TIMEOUT_FLOOR_MS, waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

const TOKEN = "e".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };
const model = (id: string): ModelInfo => ({ id, label: id, efforts: ["low", "max"] });
const listedModels = (providers: ProviderInfo[]) =>
  providers.find((p) => p.id === "listed")?.models.map((m) => m.id);

/** No CLI is installed (setup checks never reach the machine's real tools). */
const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

/** A provider whose model list the test controls; `next` is what a refresh finds. */
function listedProvider() {
  const catalog = new ModelCatalog([model("default")]);
  const state = { refreshes: 0, next: undefined as ModelInfo[] | undefined };
  const status: ProviderStatus = {
    providerId: "listed",
    installed: true,
    version: "1.0.0",
    executablePath: null,
    loggedIn: true,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: true,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const adapter: ProviderAdapter = {
    id: "listed",
    displayName: "Listed",
    detect: async () => status,
    capabilities: () => new FakeProvider().capabilities(),
    models: () => catalog.list(),
    onModelsChanged: (listener) => catalog.subscribe(listener),
    refreshModels: async (opts) => {
      // A server attaching asks with a max age; this list counts as recent.
      if (opts?.maxAgeMs !== undefined) return;
      state.refreshes += 1;
      if (state.next) catalog.set(state.next);
    },
    openSession: () => Promise.reject(new Error("not used")),
  };
  return { adapter, catalog, state };
}

describe("provider lists from the runner", () => {
  let home: string;
  let runner: RunningRunner;
  let server: RunningServer;
  let provider: ReturnType<typeof listedProvider>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "codeden-providers-"));
    provider = listedProvider();
    runner = await startRunner({ home, adapters: [provider.adapter] });
    server = await startServer({
      port: 0,
      dataDir: home,
      token: TOKEN,
      waitForRunner: true,
      secrets: "memory",
      checkSetupOnStart: false,
      userHome: home,
      exec: nothingInstalled,
      realtimeFlushMs: 10,
      runnerRequestTimeoutFloorMs: RUNNER_REQUEST_TIMEOUT_FLOOR_MS,
    });
  });

  afterEach(async () => {
    await server.close();
    await runner.close();
    await removeTree(home);
  });

  it("keeps live clients and the snapshot current when models change", async () => {
    expect(listedModels(server.runner?.status.providers ?? [])).toEqual(["default"]);
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: auth });
    const runnerUpdates: ProviderInfo[][] = [];
    ws.on("message", (data) => {
      const msg = ServerToClientMessage.parse(JSON.parse(data.toString()));
      if (msg.type === "runner") runnerUpdates.push(msg.runner.providers);
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // The connect-time status arrives first.
    await waitUntil(() => runnerUpdates.length > 0 || undefined);

    // A session (or discovery) reports the provider's real models.
    provider.catalog.set([model("gpt-new"), model("gpt-old")]);
    await waitUntil(() =>
      runnerUpdates.some((p) => listedModels(p)?.[0] === "gpt-new") ? true : undefined,
    );
    const res = await fetch(`${server.url}/api/snapshot`, { headers: auth });
    const snapshot = Snapshot.parse(await res.json());
    expect(listedModels(snapshot.runner.providers)).toEqual(["gpt-new", "gpt-old"]);
    expect(snapshot.runner.providers[0]?.models[0]?.efforts).toEqual(["low", "max"]);
    ws.close();
  });

  it("refreshes the runner's model lists after a setup re-check", async () => {
    await waitUntil(() => provider.state.refreshes >= 1 || undefined); // at runner start
    const before = provider.state.refreshes;
    provider.state.next = [model("after-login")];
    const res = await fetch(`${server.url}/api/setup/status?refresh=1`, { headers: auth });
    expect(res.status).toBe(200);
    await waitUntil(() =>
      listedModels(server.runner?.status.providers ?? [])?.[0] === "after-login" ? true : undefined,
    );
    expect(provider.state.refreshes).toBe(before + 1);
  });

  it("refreshes one provider's models on request and answers with the new lists", async () => {
    await waitUntil(() => provider.state.refreshes >= 1 || undefined); // at runner start
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: auth });
    const runnerUpdates: ProviderInfo[][] = [];
    ws.on("message", (data) => {
      const msg = ServerToClientMessage.parse(JSON.parse(data.toString()));
      if (msg.type === "runner") runnerUpdates.push(msg.runner.providers);
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // A model release since the list was taken: "Refresh models" finds it.
    provider.state.next = [model("released-today"), model("default")];
    const res = await fetch(`${server.url}/api/providers/listed/refresh-models`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = RefreshModelsResponse.parse(await res.json());
    expect(listedModels(body.providers)).toEqual(["released-today", "default"]);
    expect(listedModels(server.runner?.status.providers ?? [])).toEqual([
      "released-today",
      "default",
    ]);
    // Open pickers hear about it without asking.
    await waitUntil(() =>
      runnerUpdates.some((p) => listedModels(p)?.[0] === "released-today") ? true : undefined,
    );
    ws.close();

    const unknown = await fetch(`${server.url}/api/providers/nope/refresh-models`, {
      method: "POST",
      headers: auth,
    });
    expect(unknown.status).toBe(404);
  });
});

describe("refreshProviderModels", () => {
  it("needs a connected runner", async () => {
    const port = { isConnected: () => false } as unknown as RunnerPort;
    await expect(refreshProviderModels(port, "claude")).rejects.toMatchObject({
      status: 503,
      code: "runner_unavailable",
    });
  });

  it("falls back to the status lists when an older runner answers without them", async () => {
    const providers = [
      { id: "claude", displayName: "Claude Code", capabilities: {}, models: [model("opus")] },
    ] as unknown as ProviderInfo[];
    const sent: unknown[] = [];
    const port = {
      isConnected: () => true,
      providers: () => providers,
      request: async (command: unknown) => {
        sent.push(command);
        return { statuses: [] };
      },
    } as unknown as RunnerPort;
    await expect(refreshProviderModels(port, "claude")).resolves.toEqual({ providers });
    expect(sent).toEqual([{ name: "provider.detect", providerId: "claude", waitForModels: true }]);
  });
});

describe("redetectProviders", () => {
  it("asks only a connected runner, and only logs failures", async () => {
    let connected = false;
    const sent: string[] = [];
    const port = {
      isConnected: () => connected,
      request: async (command: { name: string }) => {
        sent.push(command.name);
        throw new Error("runner went away");
      },
    } as unknown as RunnerPort;
    const logs: string[] = [];
    redetectProviders(port, (m) => logs.push(m));
    connected = true;
    redetectProviders(port, (m) => logs.push(m));
    await waitUntil(() => logs.length > 0 || undefined);
    expect(sent).toEqual(["provider.detect"]);
    expect(logs).toEqual(["runner: provider re-detect failed: runner went away"]);
  });
});
