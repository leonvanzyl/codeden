import {
  ArchiveSessionResponse,
  ConflictRecord,
  GithubConnection,
  GithubIssueDetails,
  GithubIssuesResponse,
  GithubPrDetails,
  GithubPrsResponse,
  GithubSyncStatus,
  MergePrResponse,
  Notice,
  Overview,
  ProjectStatus,
  ResolveConflictResponse,
  RoleMessageResponse,
  RoleSessionResponse,
  Session,
  SessionGithubResponse,
  TriageIssueResult,
} from "@codeden/contracts";
import type { CodeDenClient } from "./client";
import type { GithubApi, OrchestrationApi, OrchestrationRole } from "./feature-apis";
import type { Fetcher } from "./http";
import { qs } from "./http-features";

const enc = encodeURIComponent;

const rolePath = (role: OrchestrationRole, projectId: string | null) =>
  role === "orchestrator"
    ? "/orchestration/orchestrator"
    : `/orchestration/projects/${enc(projectId ?? "")}/pm`;

/** `/api/orchestration/*`: role sessions, messages, digests and notices (§8). */
export function httpOrchestrationApi(http: Fetcher): OrchestrationApi {
  const { get, post } = http;
  return {
    ensure: (role, projectId) =>
      post(rolePath(role, projectId), {}, (v) => RoleSessionResponse.parse(v).session),
    send: (role, projectId, input, whenBusy = "queue") =>
      post(`${rolePath(role, projectId)}/messages`, { input, whenBusy }, (v) =>
        RoleMessageResponse.parse(v),
      ),
    projectStatus: (id) =>
      get(`/orchestration/projects/${enc(id)}/status`, (v) => ProjectStatus.parse(v)),
    overview: () => get("/orchestration/overview", (v) => Overview.parse(v)),
    notices: (q = {}) => get(`/orchestration/notices${qs(q)}`, (v) => Notice.array().parse(v)),
  };
}

/** `/api/github/connection`, `/api/projects/:id/github/*`, `/api/prs/:id` (§9). */
export function httpGithubApi(http: Fetcher): GithubApi {
  const { get, post } = http;
  const project = (id: string) => `/projects/${enc(id)}/github`;
  return {
    connection: () => get("/github/connection", (v) => GithubConnection.parse(v)),
    issues: (id, state = "open") =>
      get(`${project(id)}/issues${qs({ state })}`, (v) => GithubIssuesResponse.parse(v)),
    prs: (id, state = "open") =>
      get(`${project(id)}/prs${qs({ state })}`, (v) => GithubPrsResponse.parse(v)),
    issue: (id, number) =>
      get(`${project(id)}/issues/${number}`, (v) => GithubIssueDetails.parse(v)),
    sync: (id) => post(`${project(id)}/sync`, {}, (v) => GithubSyncStatus.parse(v)),
    pr: (prId) => get(`/prs/${enc(prId)}`, (v) => GithubPrDetails.parse(v)),
    merge: (prId, req = {}) =>
      post(`/prs/${enc(prId)}/merge`, req, (v) => MergePrResponse.parse(v)),
    session: (id) => get(`/sessions/${enc(id)}/github`, (v) => SessionGithubResponse.parse(v)),
    triage: (id, number, req) =>
      post(`${project(id)}/issues/${number}/triage`, req, (v) => TriageIssueResult.parse(v)),
  };
}

type SessionAndConflictApi = Pick<
  CodeDenClient,
  "updateSession" | "archiveSession" | "unarchiveSession" | "listConflicts" | "resolveConflict"
>;

/** `PATCH /api/sessions/:id` and `/api/conflicts` (§8.4). */
export function httpSessionConflictApi(http: Fetcher): SessionAndConflictApi {
  return {
    updateSession: (id, patch) =>
      http.call("PATCH", `/sessions/${enc(id)}`, patch, (v) => Session.parse(v)),
    archiveSession: (id, opts) =>
      http.post(`/sessions/${enc(id)}/archive`, opts ?? {}, (v) => ArchiveSessionResponse.parse(v)),
    unarchiveSession: (id) =>
      http.post(`/sessions/${enc(id)}/unarchive`, {}, (v) => Session.parse(v)),
    listConflicts: (q = {}) =>
      http.get(`/conflicts${qs(q)}`, (v) => ConflictRecord.array().parse(v)),
    resolveConflict: (id, request) =>
      http.post(`/conflicts/${enc(id)}/resolve`, request, (v) => ResolveConflictResponse.parse(v)),
  };
}
