import {
  AgentConfigDeleteResponse,
  AgentConfigDiff,
  AgentConfigFileContent,
  AgentConfigListResponse,
  type AgentConfigLocator,
  AgentConfigWriteResponse,
  BrowserNavigateResponse,
  BrowserOpenResponse,
  BrowserTabResponse,
  BrowserTabsResponse,
  DevServersResponse,
  HookListResponse,
  HookWriteResponse,
  ImageEnginesResponse,
  ImageTestResponse,
  LoadedAgentConfig,
  LocalSttStatus,
  McpServerListResponse,
  McpServerWriteResponse,
  SecretsStatus,
  SttResponse,
  VoiceListResponse,
} from "@codeden/contracts";
import { openBrowserSocket } from "./browser-channel";
import type { AgentConfigApi, BrowserApi, ImagesApi, SecretsApi, VoiceApi } from "./feature-apis";
import type { Fetcher } from "./http";

const enc = encodeURIComponent;

/** Query string from defined values only. */
export function qs(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === false) continue;
    params.set(key, value === true ? "1" : String(value));
  }
  return params.size ? `?${params}` : "";
}

const locatorQs = (l: AgentConfigLocator, extra: Record<string, string | undefined> = {}) =>
  qs({ root: l.root, projectId: l.projectId, path: l.path, ...extra });

/** `/api/sessions/:id/browser/*`, `/api/browser/dev-servers` and the `/ws/browser` socket. */
export function httpBrowserApi(http: Fetcher, wsBase: string): BrowserApi {
  const { get, post, call } = http;
  const base = (id: string) => `/sessions/${enc(id)}/browser`;
  return {
    openChannel: (sessionId, opts) => openBrowserSocket(wsBase, sessionId, opts),
    open: (id, url, native) =>
      post(`${base(id)}/open`, { url, native }, (v) => BrowserOpenResponse.parse(v)),
    async close(id) {
      await post(`${base(id)}/close`);
    },
    tabs: (id) => get(`${base(id)}/tabs`, (v) => BrowserTabsResponse.parse(v)),
    newTab: (id, url) => post(`${base(id)}/tabs`, { url }, (v) => BrowserTabResponse.parse(v)),
    async closeTab(id, tabId) {
      await call("DELETE", `${base(id)}/tabs/${enc(tabId)}`);
    },
    async activateTab(id, tabId) {
      await post(`${base(id)}/tabs/${enc(tabId)}/activate`);
    },
    navigate: (id, url, tabId) =>
      post(`${base(id)}/navigate`, { url, tabId }, (v) => BrowserNavigateResponse.parse(v)),
    history: (id, action, tabId) => post(`${base(id)}/history`, { action, tabId }),
    async viewport(id, width, height) {
      await post(`${base(id)}/viewport`, { width, height });
    },
    openDevServer: (id, port, path) =>
      post(`${base(id)}/dev-server`, { port, path }, (v) => BrowserTabResponse.parse(v)),
    devServers: (probe) =>
      get(`/browser/dev-servers${qs({ probe: probe?.join(",") })}`, (v) =>
        DevServersResponse.parse(v),
      ),
  };
}

/** `/api/agent-config/*` and `/api/sessions/:id/agent-config/loaded`. */
export function httpAgentConfigApi(http: Fetcher): AgentConfigApi {
  const { get, post, call } = http;
  return {
    list: (q) => get(`/agent-config/files${qs(q)}`, (v) => AgentConfigListResponse.parse(v)),
    read: (l) => get(`/agent-config/file${locatorQs(l)}`, (v) => AgentConfigFileContent.parse(v)),
    write: (req, opts) =>
      call(opts?.create ? "POST" : "PUT", "/agent-config/file", req, (v) =>
        AgentConfigWriteResponse.parse(v),
      ),
    remove: (l, opts) =>
      call(
        "DELETE",
        `/agent-config/file${locatorQs(l, { folder: opts?.folder ? "1" : undefined })}`,
        undefined,
        (v) => AgentConfigDeleteResponse.parse(v),
      ),
    diff: (req) => post("/agent-config/diff", req, (v) => AgentConfigDiff.parse(v)),
    listMcp: (projectId) =>
      get(`/agent-config/mcp${qs({ projectId })}`, (v) => McpServerListResponse.parse(v)),
    upsertMcp: (req) =>
      call("PUT", "/agent-config/mcp", req, (v) => McpServerWriteResponse.parse(v)),
    removeMcp: (t) =>
      call(
        "DELETE",
        `/agent-config/mcp${qs({ provider: t.provider, scope: t.scope, projectId: t.projectId, name: t.name })}`,
        undefined,
        (v) => McpServerWriteResponse.parse(v),
      ),
    diffMcp: (req) => post("/agent-config/mcp/diff", req, (v) => AgentConfigDiff.parse(v)),
    listHooks: (projectId) =>
      get(`/agent-config/hooks${qs({ projectId })}`, (v) => HookListResponse.parse(v)),
    diffHook: (req) => post("/agent-config/hooks/diff", req, (v) => AgentConfigDiff.parse(v)),
    changeHook: (req) => post("/agent-config/hooks", req, (v) => HookWriteResponse.parse(v)),
    loaded: (id) =>
      get(`/sessions/${enc(id)}/agent-config/loaded`, (v) => LoadedAgentConfig.parse(v)),
  };
}

/** `/api/images/*`. */
export function httpImagesApi(http: Fetcher): ImagesApi {
  return {
    engines: (projectId) =>
      http.get(`/images/engines${qs({ projectId })}`, (v) => ImageEnginesResponse.parse(v)),
    test: (req) => http.post("/images/test", req, (v) => ImageTestResponse.parse(v)),
  };
}

/** `/api/voice/voices`, `/api/tts`, `/api/stt`. */
export function httpVoiceApi(http: Fetcher): VoiceApi {
  return {
    voices: () => http.get("/voice/voices", (v) => VoiceListResponse.parse(v)),
    async tts(req) {
      const res = await http.raw("POST", "/tts", {
        body: JSON.stringify(req),
        contentType: "application/json",
      });
      return res.blob();
    },
    async stt(audio, query) {
      const res = await http.raw("POST", `/stt${qs(query)}`, {
        body: audio,
        contentType: audio.type || "audio/webm",
      });
      return SttResponse.parse(await res.json());
    },
    localStatus: () => http.get("/voice/local", (v) => LocalSttStatus.parse(v)),
    downloadLocalModel: (id) =>
      http.post(`/voice/local/models/${enc(id)}/download`, undefined, (v) =>
        LocalSttStatus.parse(v),
      ),
    deleteLocalModel: (id) =>
      http.call("DELETE", `/voice/local/models/${enc(id)}`, undefined, (v) =>
        LocalSttStatus.parse(v),
      ),
  };
}

/** `/api/secrets`. */
export function httpSecretsApi(http: Fetcher): SecretsApi {
  return {
    status: () => http.get("/secrets", (v) => SecretsStatus.parse(v)),
    async set(key, value) {
      await http.call("PUT", `/secrets/${enc(key)}`, { value });
    },
    async remove(key) {
      await http.call("DELETE", `/secrets/${enc(key)}`);
    },
  };
}
