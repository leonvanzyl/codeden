import {
  ClaudeSdkStatus,
  CreateProjectResponse,
  DiffResult,
  DisconnectGithubResponse,
  ForkSessionResponse,
  FsListResponse,
  GitCommitResponse,
  GitPushResponse,
  GitStatusResponse,
  InboxItem,
  LoginCommandResponse,
  Project,
  RefreshModelsResponse,
  RefreshProjectResponse,
  ReorderProjectsResponse,
  RestoreFilesResponse,
  type SendMessageRequestInit,
  SessionDetail,
  SessionFileContent,
  SessionFileList,
  SessionSnapshot,
  Settings,
  SetupStatus,
  Snapshot,
  SpeechSummaryResponse,
  StartSessionResponse,
  TranscriptSearchResponse,
  UpdateStatus,
} from "@codeden/contracts";
import { httpAutomationsApi } from "./automations-api";
import type { CodeDenClient, SendMode } from "./client";
import { httpFactoryApi } from "./factory-api";
import { createFetcher } from "./http";
import {
  httpAgentConfigApi,
  httpBrowserApi,
  httpImagesApi,
  httpSecretsApi,
  httpVoiceApi,
} from "./http-features";
import { httpGithubApi, httpOrchestrationApi, httpSessionConflictApi } from "./http-orchestration";
import { configApi } from "./http-unwired";
import { httpAuthApi, httpNetworkApi } from "./network-api";
import { httpQueueApi } from "./queue-api";
import { RealtimeSocket } from "./realtime-socket";
import { openTerminalSocket } from "./terminal-channel";
import type { MentionCandidate } from "./types";
import { httpUpdatesApi } from "./updates-api";

const whenBusy: Record<SendMode, SendMessageRequestInit["whenBusy"]> = {
  send: "queue",
  queue: "queue",
  steer: "steer",
};

export interface HttpClientOptions {
  /**
   * Called when the server answers 401 (missing or expired cookie), with the server's code:
   * `sign_in_required` for a remote device that has to sign in with the password.
   */
  onUnauthorized?: (code: string) => void;
}

/**
 * Real client: fetch + WebSocket against the CodeDen server's `/api`, `/ws` and `/ws/pty`.
 * Request and response shapes come from `@codeden/contracts`; responses are validated.
 */
export function createHttpClient(origin: string, opts: HttpClientOptions = {}): CodeDenClient {
  const http = createFetcher(origin, opts.onUnauthorized ?? (() => {}));
  const { get, post, call } = http;
  const wsBase = origin.replace(/^http/, "ws");
  const socket = new RealtimeSocket(`${wsBase}/ws`);
  const enc = encodeURIComponent;
  const fileCache = new Map<string, { at: number; list: SessionFileList }>();

  return {
    kind: "http",
    getSnapshot: () => get("/snapshot", (v) => Snapshot.parse(v)),
    getSessionSnapshot: (id) =>
      get(`/sessions/${enc(id)}/snapshot`, (v) => SessionSnapshot.parse(v)),
    subscribe: (fromSeq, onMessage) => socket.subscribe(fromSeq, onMessage),
    watchSession: (id, fromSeq, onMessage) => socket.watch(id, fromSeq, onMessage),
    onConnectionChange: (listener) => socket.onState(listener),

    getSessionDetail: (id) => get(`/sessions/${enc(id)}`, (v) => SessionDetail.parse(v)),
    async sendMessage(id, input, mode) {
      const body: SendMessageRequestInit = { input, whenBusy: whenBusy[mode] };
      await post(`/sessions/${enc(id)}/messages`, body);
    },
    async interrupt(id) {
      await post(`/sessions/${enc(id)}/interrupt`);
    },
    async respond(id, requestId, response) {
      await post(`/sessions/${enc(id)}/respond`, { requestId, response });
    },
    // A 409 conflict is persisted by the server (`conflictId`) and listed by `listConflicts`.
    startSession: (input) => fetchStart(origin, input),
    async stopSession(id) {
      await post(`/sessions/${enc(id)}/stop`);
    },
    forkSession: (id, req) =>
      post(`/sessions/${enc(id)}/fork`, req ?? {}, (v) => ForkSessionResponse.parse(v)),
    queue: httpQueueApi(http),
    searchTranscripts: ({ q, projectId, limit }) => {
      const params = new URLSearchParams({ q });
      if (projectId) params.set("projectId", projectId);
      if (limit) params.set("limit", String(limit));
      return get(`/search/transcripts?${params}`, (v) => TranscriptSearchResponse.parse(v));
    },

    ...httpSessionConflictApi(http),
    resolveInbox: (id, resolution) =>
      post(`/inbox/${enc(id)}/resolve`, resolution, (v) => InboxItem.parse(v)),

    createProject: (input) => post("/projects", input, (v) => CreateProjectResponse.parse(v)),
    updateProject: (id, patch) =>
      call("PATCH", `/projects/${enc(id)}`, patch, (v) => Project.parse(v)),
    reorderProjects: (projectIds) =>
      call("PUT", "/projects/order", { projectIds }, (v) => ReorderProjectsResponse.parse(v)).then(
        (r) => r.projects,
      ),
    refreshProject: (id) =>
      post(`/projects/${enc(id)}/refresh`, {}, (v) => RefreshProjectResponse.parse(v)),
    disconnectGithub: (id) =>
      post(`/projects/${enc(id)}/disconnect-github`, {}, (v) => DisconnectGithubResponse.parse(v)),
    automations: httpAutomationsApi(http),
    factory: httpFactoryApi(http),

    updateSettings: (patch) => call("PATCH", "/settings", patch, (v) => Settings.parse(v)),
    secrets: httpSecretsApi(http),
    network: httpNetworkApi(http),
    auth: httpAuthApi(origin),

    getSetupStatus: (o) =>
      get(`/setup/status${o?.refresh ? "?refresh=1" : ""}`, (v) => SetupStatus.parse(v)),
    loginCommand: (tool) => post(`/setup/login/${tool}`, {}, (v) => LoginCommandResponse.parse(v)),
    refreshModels: (providerId) =>
      post(`/providers/${encodeURIComponent(providerId)}/refresh-models`, {}, (v) =>
        RefreshModelsResponse.parse(v),
      ),
    getClaudeSdkStatus: () => get("/setup/claude-sdk", (v) => ClaudeSdkStatus.parse(v)),
    installClaudeSdk: () => post("/setup/claude-sdk/install", {}, (v) => ClaudeSdkStatus.parse(v)),
    getUpdates: (o) =>
      get(`/updates${o?.refresh ? "?refresh=1" : ""}`, (v) => UpdateStatus.parse(v)),
    updates: httpUpdatesApi(http, origin),
    async completeSetup() {
      await post("/setup/complete");
    },
    listDirectory(path, o) {
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      if (o?.showHidden) params.set("showHidden", "1");
      const qs = params.size ? `?${params}` : "";
      return get(`/fs/list${qs}`, (v) => FsListResponse.parse(v));
    },

    getDiff: (id, scope) => post(`/sessions/${enc(id)}/diff`, scope, (v) => DiffResult.parse(v)),
    restoreFiles: (id, req) =>
      post(`/sessions/${enc(id)}/restore`, req, (v) => RestoreFilesResponse.parse(v)),
    gitStatus: (id) => get(`/sessions/${enc(id)}/git/status`, (v) => GitStatusResponse.parse(v)),
    gitCommit: (id, req) =>
      post(`/sessions/${enc(id)}/git/commit`, req, (v) => GitCommitResponse.parse(v)),
    gitPush: (id, req) =>
      post(`/sessions/${enc(id)}/git/push`, req, (v) => GitPushResponse.parse(v)),
    listFiles: (id) => get(`/sessions/${enc(id)}/files`, (v) => SessionFileList.parse(v)),
    readFile: (id, path) =>
      get(`/sessions/${enc(id)}/files/content?path=${enc(path)}`, (v) =>
        SessionFileContent.parse(v),
      ),
    async searchMentions(id, query) {
      const cached = fileCache.get(id);
      const list =
        cached && Date.now() - cached.at < 30_000
          ? cached.list
          : await get(`/sessions/${enc(id)}/files`, (v) => SessionFileList.parse(v));
      fileCache.set(id, { at: cached?.list === list ? cached.at : Date.now(), list });
      return rankMentions(list, query);
    },
    openTerminal: (o) => openTerminalSocket(wsBase, o),
    artifactUrl: (id) => `${origin}/api/artifacts/${enc(id)}`,
    speechSummary: (text) =>
      post("/utility/speech-summary", { text }, (v) => SpeechSummaryResponse.parse(v)),

    browser: httpBrowserApi(http, wsBase),
    agentConfig: httpAgentConfigApi(http),
    images: httpImagesApi(http),
    voice: httpVoiceApi(http),
    orchestration: httpOrchestrationApi(http),
    github: httpGithubApi(http),
    ...configApi(http),
  };
}

/** `@` mention candidates: paths containing the query, shortest first. */
export function rankMentions(list: SessionFileList, query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  return list.entries
    .filter((e) => e.path.toLowerCase().includes(q))
    .sort((a, b) => a.path.length - b.path.length)
    .slice(0, 8)
    .map((e) => ({ path: e.path, kind: e.kind }));
}

/** `POST /api/sessions` answers 409 for a conflict; that body is a result, not an error. */
async function fetchStart(origin: string, input: unknown): Promise<StartSessionResponse> {
  const res = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const json: unknown = await res.json().catch(() => null);
  const parsed = StartSessionResponse.safeParse(json);
  if (parsed.success) return parsed.data;
  const message =
    (json as { error?: { message?: string } } | null)?.error?.message ??
    `Couldn't start the session (${res.status})`;
  throw new Error(message);
}
