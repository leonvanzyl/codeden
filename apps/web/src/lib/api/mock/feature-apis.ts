import type {
  AgentConfigDiff,
  AgentConfigFileContent,
  AgentConfigLocator,
  ImageEnginesResponse,
  McpServerEntry,
  SecretKey,
} from "@codeden/contracts";
import type { CodeDenClient } from "../client";
import type { AgentConfigApi, ImagesApi, SecretsApi, VoiceApi } from "../feature-apis";
import { mockBrowserApi } from "./browser";
import { configContents, configFiles, mcpServers } from "./fixtures/config";
import { mockHooksApi } from "./hooks";
import { mockLocalStt } from "./local-stt";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

/** A small unified diff: common prefix and suffix lines kept, the middle replaced. */
export function naiveDiff(path: string, before: string, after: string): AgentConfigDiff {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const ctx = a.slice(Math.max(0, start - 2), start);
  const header = `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    header,
    ...ctx.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ];
  const changed = removed.length > 0 || added.length > 0;
  return {
    absolutePath: path,
    exists: before !== "",
    patch: changed ? `${lines.join("\n")}\n` : "",
    additions: added.length,
    deletions: removed.length,
    changed,
  };
}

const key = (l: AgentConfigLocator) => `cfg:${l.root}:${l.projectId ?? ""}:${l.path}`;

function mockAgentConfig(world: MockWorld): AgentConfigApi {
  let servers: McpServerEntry[] = structuredClone(mcpServers);
  const hooksApi = mockHooksApi(naiveDiff);
  const content = (l: AgentConfigLocator) =>
    world.files.get(key(l)) ?? configContents[l.path] ?? "";
  const read = (l: AgentConfigLocator): AgentConfigFileContent => {
    const text = content(l);
    const known = configFiles.find((f) => f.path === l.path && f.root === l.root);
    return {
      ...l,
      absolutePath: known?.absolutePath ?? l.path,
      exists: text !== "" || Boolean(known?.exists),
      content: text,
      sha256: text ? `sha-${text.length}` : null,
    };
  };
  return {
    list: (q) =>
      delay({
        files: configFiles.filter(
          (f) => (!q.provider || f.provider === q.provider) && (!q.kind || f.kind === q.kind),
        ),
        autoMemoryDir: q.projectId
          ? "C:\\Users\\you\\.claude\\projects\\C--Code-storefront\\memory"
          : null,
      }),
    read: (l) => delay(read(l), 80),
    write: (req) => {
      const { content: next, expectedSha256: _sha, ...l } = req;
      const hadFile = content(l) !== "";
      world.files.set(key(l), next);
      return delay(
        { file: read(l), backupPath: hadFile ? `~/.codeden/backups/agent-config/${l.path}` : null },
        200,
      );
    },
    remove: (l) => {
      world.files.set(key(l), "");
      return delay({ deleted: true, backupPath: `~/.codeden/backups/agent-config/${l.path}` });
    },
    diff: (req) => delay(naiveDiff(req.path, content(req), req.content), 100),
    listMcp: () => delay({ servers }),
    upsertMcp: (req) => {
      const { spec, ...t } = req;
      servers = servers.filter(
        (s) => !(s.provider === t.provider && s.scope === t.scope && s.name === t.name),
      );
      servers.push({ ...t, spec, file: "mock", projectId: t.projectId ?? null });
      return delay({ file: "mock", backupPath: "~/.codeden/backups/agent-config/mock", servers });
    },
    removeMcp: (t) => {
      servers = servers.filter(
        (s) => !(s.provider === t.provider && s.scope === t.scope && s.name === t.name),
      );
      return delay({ file: "mock", backupPath: "~/.codeden/backups/agent-config/mock", servers });
    },
    diffMcp: (req) => {
      const before = servers.find((s) => s.name === req.name && s.provider === req.provider);
      const show = (v: unknown) => (v ? JSON.stringify({ [req.name]: v }, null, 2) : "");
      return delay(naiveDiff("mcp", show(before?.spec), show(req.spec)));
    },
    ...hooksApi,
    loaded: async (sessionId) => {
      const files = configFiles.filter((f) => f.exists);
      // The storefront project's hooks; the disabled ones (on the shelf) don't run.
      const hooks = await hooksApi.listHooks("p-storefront");
      return delay({
        sessionId,
        provider: "claude",
        cwd: "C:\\Users\\you\\.codeden\\wt\\storefront\\fix-checkout-flake",
        memory: files.filter((f) => f.kind === "memory" || f.kind === "rule"),
        skills: files
          .filter((f) => f.kind === "skill")
          .map((f) => ({
            provider: f.provider,
            scope: f.scope,
            name: f.name,
            description: f.description,
            file: f,
          })),
        subagents: files.filter((f) => f.kind === "subagent"),
        mcpServers: servers.filter((s) => s.provider !== "codex"),
        hooks: {
          sources: hooks.sources,
          hooks: hooks.hooks.filter((h) => h.enabled),
          disabledBy: null,
        },
      });
    },
  };
}

function mockImages(): ImagesApi {
  const engines: ImageEnginesResponse = {
    engines: [
      {
        id: "codex",
        label: "Codex",
        available: true,
        reason: "Signed in with ChatGPT",
        requiresApiKey: false,
        referenceImages: true,
        exactSize: false,
        defaultModel: "gpt-image-1",
      },
      {
        id: "gemini",
        label: "Gemini",
        available: false,
        reason: "Add a Google AI API key",
        requiresApiKey: true,
        referenceImages: true,
        exactSize: false,
        defaultModel: "gemini-2.5-flash-image",
      },
      {
        id: "openai",
        label: "OpenAI Images",
        available: false,
        reason: "Add an OpenAI API key",
        requiresApiKey: true,
        referenceImages: true,
        exactSize: true,
        defaultModel: "gpt-image-1",
      },
    ],
    active: { engine: "codex" },
    usage: { date: new Date().toISOString().slice(0, 10), total: 3, byProject: {} },
    dailyCap: 50,
  };
  return {
    engines: () => delay(engines),
    test: () =>
      delay(
        {
          ok: true,
          engine: "codex" as const,
          model: "gpt-image-1",
          durationMs: 7200,
          artifact: {
            id: "art-hero",
            kind: "image" as const,
            name: "test.png",
            mediaType: "image/png",
            path: "generated/test.png",
            sizeBytes: 182_000,
            sha256: null,
            projectId: null,
            sessionId: null,
            threadId: null,
            itemId: null,
            createdAt: new Date().toISOString(),
          },
        },
        1200,
      ),
  };
}

function mockVoice(): VoiceApi {
  const local = mockLocalStt();
  return {
    localStatus: () => delay(local.status()),
    downloadLocalModel: (id) => delay(local.download(id)),
    deleteLocalModel: (id) => delay(local.remove(id)),
    voices: () =>
      delay({
        voices: [
          { id: "v-rachel", name: "Rachel", category: "premade" },
          { id: "v-adam", name: "Adam", category: "premade" },
        ],
      }),
    tts: () => delay(new Blob([], { type: "audio/mpeg" })),
    stt: (_audio, query) =>
      delay(
        query.engine === "local"
          ? {
              text: "Run the checkout tests again",
              language: "en",
              engine: "local",
              elapsedMs: 640,
            }
          : { text: "Run the checkout tests again", language: "en", engine: "elevenlabs" },
        600,
      ),
  };
}

function mockSecrets(): SecretsApi {
  const set = new Set<SecretKey>();
  return {
    status: () =>
      delay({
        backend: "memory" as const,
        keys: (
          ["elevenlabs.apiKey", "openai.apiKey", "gemini.apiKey", "anthropic.apiKey"] as const
        ).map((k) => ({ key: k, set: set.has(k) })),
      }),
    async set(k) {
      set.add(k);
    },
    async remove(k) {
      set.delete(k);
    },
  };
}

type FeatureApis = Pick<CodeDenClient, "browser" | "agentConfig" | "images" | "voice" | "secrets">;

/** Browser, agent configuration, images, voice and secrets for the mock client. */
export function mockFeatureApis(world: MockWorld): FeatureApis {
  return {
    browser: mockBrowserApi(),
    agentConfig: mockAgentConfig(world),
    images: mockImages(),
    voice: mockVoice(),
    secrets: mockSecrets(),
  };
}
