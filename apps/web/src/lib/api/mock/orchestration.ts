import {
  ConflictDecision,
  type GithubConnection,
  type GithubPr,
  type GithubPrDetails,
  type ProjectStatus,
  type Session,
  type StartSessionResponse,
  type WorkSummary,
} from "@codeden/contracts";
import type { CodeDenClient } from "../client";
import { checks, mockIssues, mockPrs, searchPrChecksLater } from "./fixtures/github";
import { makeSession } from "./fixtures/helpers";
import { uid } from "./live";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const connection: GithubConnection = {
  connected: true,
  source: "gh",
  login: "leon",
  message: null,
};

type OrchestrationParts = Pick<
  CodeDenClient,
  "orchestration" | "github" | "updateSession" | "listConflicts" | "resolveConflict"
>;

interface Deps {
  sendMessage: CodeDenClient["sendMessage"];
  /** Start a fresh agent session for a forced conflict; returns its id. */
  createSession: (projectId: string, prompt: string, workKey: string) => string;
}

function summary(s: Session): WorkSummary {
  return {
    kind: "session",
    id: s.id,
    sessionId: s.id,
    projectId: s.projectId,
    startedBy: s.startedBy,
    purpose: s.purpose,
    workKey: s.workKey,
    scope: s.scope,
    progress: s.progress,
    status: s.status,
    startedAt: s.createdAt,
  };
}

/** Orchestration, conflicts and GitHub for the mock client. */
export function mockOrchestration(world: MockWorld, deps: Deps): OrchestrationParts {
  const roleSession = (role: "orchestrator" | "pm", projectId: string | null) =>
    world.snapshot.sessions.find(
      (s) => s.role === role && (role === "orchestrator" || s.projectId === projectId),
    );
  const ensure = (role: "orchestrator" | "pm", projectId: string | null): Session => {
    const found = roleSession(role, projectId);
    if (found) return found;
    const session = makeSession({
      id: uid("s"),
      projectId,
      role,
      status: "idle",
      provider: "claude",
      model: "sonnet",
      purpose: role === "pm" ? "Project manager" : "Orchestrator",
      workKey: role === "pm" ? `pm:${projectId}` : "orchestrator:main",
    });
    world.emitDomain({ type: "session.created", sessionId: null, payload: { session } });
    return session;
  };
  const projectStatus = (projectId: string): ProjectStatus => {
    const project = world.snapshot.projects.find((p) => p.id === projectId);
    const sessions = world.snapshot.sessions.filter(
      (s) => s.projectId === projectId && s.role === "agent",
    );
    const inbox = world.snapshot.inbox.filter(
      (i) => i.projectId === projectId && i.status === "open",
    );
    return {
      project: {
        id: projectId,
        name: project?.name ?? projectId,
        kind: project?.kind ?? "local",
        mode: project?.autonomyMode ?? "assisted",
      },
      running: sessions
        .filter((s) => ["starting", "running", "waiting"].includes(s.status))
        .map(summary),
      queued: sessions.filter((s) => s.status === "queued").map(summary),
      scheduled: world.snapshot.scheduled.filter((r) => r.projectId === projectId),
      inbox: {
        open: inbox.length,
        items: inbox.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          sessionId: i.sessionId,
        })),
      },
      recent: [],
    };
  };
  // PR 57's checks move on 20 s after the mock starts, so the next refetch shows a check finish.
  const startedAt = Date.now();
  const live = (p: GithubPrDetails): GithubPrDetails =>
    p.number === 57 && Date.now() - startedAt > 20_000
      ? { ...p, checks: checks(searchPrChecksLater) }
      : p;
  const prsFor = (projectId: string): GithubPr[] =>
    mockPrs
      .filter((p) => p.projectId === projectId)
      .map(live)
      .map(({ body: _b, additions: _a, deletions: _d, files: _f, ...rest }) => rest);
  const prById = (id: string) => {
    const found = mockPrs.find((p) => p.id === id);
    if (!found) throw new Error(`No PR ${id}`);
    return live(found);
  };

  return {
    async updateSession(id, patch) {
      const session = world.snapshot.sessions.find((s) => s.id === id);
      if (!session) throw new Error("Session not found");
      const next = { ...session, ...patch, updatedAt: new Date().toISOString() } as Session;
      world.emitDomain({ type: "session.updated", sessionId: id, payload: { session: next } });
      return next;
    },
    listConflicts: (q = {}) =>
      delay(world.conflicts.filter((c) => !q.projectId || c.projectId === q.projectId)),
    async resolveConflict(id, request) {
      const record = world.conflicts.find((c) => c.id === id);
      if (!record) throw new Error("Conflict not found");
      world.conflicts = world.conflicts.filter((c) => c.id !== id);
      // Like the server: `start` replaces the saved request; only the decision is kept.
      const decision = ConflictDecision.parse(request);
      const text = request.start?.input?.text || record.request.purpose;
      let result: StartSessionResponse = { status: "skipped" };
      if (decision.resolution === "join") {
        await deps.sendMessage(decision.sessionId, { text }, "queue");
        result = { status: "joined", sessionId: decision.sessionId };
      }
      if (decision.resolution === "force" && record.projectId) {
        const sessionId = deps.createSession(
          record.projectId,
          text.split("\n")[0] || record.request.purpose,
          request.start?.workKey ?? record.request.workKey,
        );
        result = { status: "started", sessionId };
      }
      const now = new Date().toISOString();
      return {
        conflict: { ...record, status: "resolved", resolution: decision, resolvedAt: now },
        result,
      };
    },
    orchestration: {
      ensure: (role, projectId) => delay(ensure(role, projectId)),
      async send(role, projectId, input, whenBusy = "queue") {
        const session = ensure(role, projectId);
        // Like the server: a message to a busy role session waits in its queue.
        await deps.sendMessage(session.id, input, whenBusy === "steer" ? "steer" : "queue");
        return { sessionId: session.id, status: "sent" };
      },
      projectStatus: (id) => delay(projectStatus(id)),
      overview: () =>
        delay({
          generatedAt: new Date().toISOString(),
          projects: world.snapshot.projects.map((p) => projectStatus(p.id)),
          sharedWork: [],
          pmMessages: [],
        }),
      notices: () => delay([]),
    },
    github: {
      connection: () => delay(connection),
      issues: (projectId) =>
        delay({
          connection,
          sync: null,
          issues: mockIssues.filter((i) => i.projectId === projectId),
        }),
      prs: (projectId) => delay({ connection, sync: null, prs: prsFor(projectId) }),
      async issue(projectId, number) {
        const found = mockIssues.find((i) => i.projectId === projectId && i.number === number);
        if (!found) throw new Error("Issue not found");
        return delay({ ...found, recentComments: [] });
      },
      sync: (projectId) =>
        delay({
          projectId,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          intervalMs: 60_000,
          nextSyncAt: null,
        }),
      pr: (id) => delay(prById(id)),
      merge: () => delay({ merged: true, sha: "9f8e7d6" }),
      async session(sessionId) {
        const session = world.snapshot.sessions.find((s) => s.id === sessionId);
        const pr = mockPrs.find((p) => p.sessionId === sessionId);
        return delay({
          connection,
          issue: session?.issue ?? null,
          pr: pr ? (prsFor(pr.projectId).find((p) => p.id === pr.id) ?? null) : null,
        });
      },
      async triage(projectId, number, req) {
        const issue = mockIssues.find((i) => i.projectId === projectId && i.number === number);
        if (!issue) throw new Error("Issue not found");
        return delay({ issue, decision: req.decision, commentUrl: null, closed: false });
      },
    },
  };
}
