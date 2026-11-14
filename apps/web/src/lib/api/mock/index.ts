import {
  type MessageSender,
  Settings,
  type SettingsPatch,
  utf8ByteLength,
} from "@codeden/contracts";
import type { CodeDenClient } from "../client";
import { startAmbient } from "./ambient";
import { mockAutomationsApi } from "./automations";
import { mockFactoryApi } from "./factory";
import { startFactoryDemo } from "./factory-demo";
import { mockFeatureApis } from "./feature-apis";
import { makeSession } from "./fixtures/helpers";
import { type Script, scriptedTurn, uid } from "./live";
import { mockOrchestration } from "./orchestration";
import { mockProjectApi } from "./projects";
import { MockQueue } from "./queue";
import { respond } from "./responses";
import { mockSearch } from "./search";
import { workbenchApi } from "./workbench-api";
import { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out as T;
}

export interface MockClientOptions {
  /** Start background activity (streaming sessions). Off in tests. */
  ambient?: boolean;
}

/** Fully featured in-memory client with rich fixtures and scripted live events. */
export function createMockClient(opts: MockClientOptions = {}): CodeDenClient {
  const world = new MockWorld();
  const running = new Map<string, Script>();
  const queue = new MockQueue(world);
  if (opts.ambient) {
    startAmbient(world);
    startFactoryDemo(world);
  }

  const runTurn = (sessionId: string, text: string, from?: MessageSender) => {
    const script = scriptedTurn(world, sessionId, { text, ...(from ? { from } : {}) }, () => {
      running.delete(sessionId);
      const next = queue.shift(sessionId);
      if (next) runTurn(sessionId, next.input.text);
    });
    running.set(sessionId, script.start());
  };

  const createSession = (projectId: string, prompt: string, workKey: string, planMode = false) => {
    const id = uid("s");
    const project = world.snapshot.projects.find((p) => p.id === projectId);
    const session = makeSession({
      id,
      projectId,
      role: "agent",
      status: "starting",
      provider: "claude",
      model: "opus",
      purpose: prompt.split(/[.\n]/)[0]?.slice(0, 60) ?? "New session",
      workKey,
      planMode,
      branch: `codeden/${id.slice(2, 10)}`,
      baseBranch: "main",
      worktreePath: `~/.codeden/wt/${project?.slug ?? "project"}/${id.slice(2, 10)}`,
      createdAt: new Date().toISOString(),
    });
    world.emitDomain({ type: "session.created", sessionId: null, payload: { session } });
    runTurn(id, prompt);
    return id;
  };

  const client: CodeDenClient = {
    kind: "mock",
    getSnapshot: () => delay(world.snapshot, 150),
    getSessionSnapshot: (id) => delay(world.sessionSnapshot(id), 120),
    searchTranscripts: (req) => delay(mockSearch(world, req), 150),
    subscribe: (fromSeq, onMessage) => world.subscribe(fromSeq, onMessage),
    // Agent events arrive on the global stream in the mock, so watches have nothing to add.
    watchSession: () => () => {},
    onConnectionChange(listener) {
      listener("open");
      return () => {};
    },
    getSessionDetail: (id) =>
      delay(
        {
          session: world.sessionSnapshot(id).session,
          usage: null,
          followups: null,
          startMeta: null,
          queuedMessages: queue.count(id),
        },
        60,
      ),
    getToolOutput(sessionId, itemId) {
      const item = world.item(sessionId, itemId);
      if (item?.kind !== "tool_call") return Promise.reject(new Error("No such tool call"));
      const text = item.output?.text ?? "";
      const totalBytes = utf8ByteLength(text);
      const truncated = item.output?.truncated ?? false;
      const outputBytes = Math.max(totalBytes, item.output?.totalBytes ?? totalBytes);
      return delay({ itemId, text, totalBytes, truncated, outputBytes }, 80);
    },

    async sendMessage(sessionId, input, mode) {
      const active = running.get(sessionId);
      if (active && mode === "queue") {
        queue.push(sessionId, { text: input.text, attachments: input.attachments ?? [] });
        return;
      }
      if (active && mode === "steer") {
        const t = world.transcript(sessionId);
        const turnId = t.threads[t.rootThreadId ?? ""]?.turnIds.at(-1);
        if (turnId && t.rootThreadId)
          world.emitAgent(sessionId, {
            type: "item.completed",
            threadId: t.rootThreadId,
            turnId,
            item: {
              id: uid("u"),
              kind: "user_message",
              status: "completed",
              input: { text: input.text, attachments: input.attachments ?? [] },
            },
          });
        return;
      }
      runTurn(sessionId, input.text);
    },
    async interrupt(sessionId) {
      queue.clear(sessionId);
      running.get(sessionId)?.cancel();
      running.delete(sessionId);
      const t = world.transcript(sessionId);
      const thread = t.threads[t.rootThreadId ?? ""];
      const turnId = thread?.turnIds.at(-1);
      if (thread && turnId && t.turns[turnId]?.status === "running") {
        world.emitAgent(sessionId, {
          type: "turn.interrupted",
          threadId: thread.id,
          turnId,
          reason: "user",
        });
      }
      world.updateSession(sessionId, { status: "idle" });
    },
    async respond(sessionId, requestId, response) {
      const script = respond(world, sessionId, requestId, response);
      if (script) running.set(sessionId, script.start());
    },
    async startSession(input) {
      const prompt = input.input?.text ?? "";
      const projectId = input.projectId ?? "";
      const workKey = input.workKey ?? `request:${uid("w")}`;
      const clash = world.snapshot.sessions.find(
        (s) =>
          s.projectId === projectId &&
          s.workKey === workKey &&
          ["running", "waiting", "starting", "queued"].includes(s.status),
      );
      // Like the server, a decision settles the conflict (wait and force start at once here).
      const decision = clash ? input.conflict : undefined;
      if (decision?.resolution === "skip") return { status: "skipped" };
      if (decision?.resolution === "join") {
        await client.sendMessage(decision.sessionId, { text: prompt }, "queue");
        return { status: "joined", sessionId: decision.sessionId };
      }
      if (clash && !decision) {
        return {
          status: "conflict",
          existing: [
            {
              kind: "session",
              id: clash.id,
              sessionId: clash.id,
              projectId: clash.projectId,
              startedBy: clash.startedBy,
              purpose: clash.purpose,
              workKey: clash.workKey,
              scope: clash.scope,
              progress: clash.progress,
              status: clash.status,
              startedAt: clash.createdAt,
            },
          ],
        };
      }
      return {
        status: "started",
        sessionId: createSession(projectId, prompt, workKey, input.planMode === true),
      };
    },
    async stopSession(sessionId) {
      queue.clear(sessionId);
      running.get(sessionId)?.cancel();
      // Like the server: a session that already finished keeps its status.
      const status = world.snapshot.sessions.find((s) => s.id === sessionId)?.status;
      if (status === "completed" || status === "failed" || status === "stopped") return;
      world.updateSession(sessionId, { status: "stopped", endedAt: new Date().toISOString() });
    },
    async forkSession(sessionId, req) {
      const source = world.snapshot.sessions.find((s) => s.id === sessionId);
      if (!source) throw new Error("Session not found");
      if (running.has(sessionId)) throw new Error("Wait for the running turn to finish");
      const id = uid("s");
      const project = world.snapshot.projects.find((p) => p.id === source.projectId);
      // The named turn's number among the source's own turns, like the server records it.
      const t = world.transcript(sessionId);
      const turnNumber = req?.turnId
        ? (t.threads[t.rootThreadId ?? ""]?.turnIds.indexOf(req.turnId) ?? -1) + 1
        : 0;
      const session = makeSession({
        ...source,
        id,
        title: req?.title ?? `${source.title ?? source.purpose} (fork)`,
        status: "idle",
        startedBy: { kind: "user" },
        parentSessionId: null,
        pr: null,
        progress: null,
        result: null,
        archivedAt: null,
        worktreeRemovedAt: null,
        branch: `codeden/${id.slice(2, 10)}`,
        worktreePath: `~/.codeden/wt/${project?.slug ?? "project"}/${id.slice(2, 10)}`,
        forkedFrom: {
          sessionId,
          checkpoint: null,
          ...(req?.turnId ? { turnId: req.turnId } : {}),
          ...(turnNumber > 0 ? { turnNumber } : {}),
        },
        rootThreadId: `t-${id.slice(2)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        endedAt: null,
      });
      world.emitDomain({ type: "session.created", sessionId: null, payload: { session } });
      return delay({ sessionId: id }, 200);
    },
    async handoffSession(sessionId, req) {
      const source = world.snapshot.sessions.find((s) => s.id === sessionId);
      if (!source) throw new Error("Session not found");
      if (running.has(sessionId)) throw new Error("Wait for the running turn to finish");
      const target = world.snapshot.runner.providers.find((p) => p.id === req.provider);
      if (!target) throw new Error(`Provider ${req.provider} is not available`);
      const id = uid("s");
      const project = world.snapshot.projects.find((p) => p.id === source.projectId);
      const same = target.id === source.provider;
      const now = new Date().toISOString();
      const session = makeSession({
        ...source,
        id,
        provider: target.id,
        model: req.model ?? (same ? source.model : null),
        effort: req.effort ?? (same ? source.effort : null),
        title: req.title ?? `${source.title ?? source.purpose} (to ${target.displayName})`,
        status: "starting",
        startedBy: { kind: "user" },
        parentSessionId: null,
        pr: null,
        progress: null,
        result: null,
        resumeToken: null,
        archivedAt: null,
        worktreeRemovedAt: null,
        branch: `codeden/${id.slice(2, 10)}`,
        worktreePath: `~/.codeden/wt/${project?.slug ?? "project"}/${id.slice(2, 10)}`,
        forkedFrom: { sessionId, checkpoint: null, kind: "handoff" },
        rootThreadId: `t-${id.slice(2)}`,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      });
      world.emitDomain({ type: "session.created", sessionId: null, payload: { session } });
      const brief = [
        `You are taking over a coding task from another CodeDen session, "${source.title ?? source.purpose}". You don't have its conversation: this brief is what it did.`,
        `## The task\n\n${source.purpose}`,
        "## Where it got to\n\nThe server writes this from the session's transcript.",
        req.note
          ? `## What to do next (from the user)\n\n${req.note}`
          : "## What to do next\n\nContinue the work where it left off.",
      ].join("\n\n");
      runTurn(id, brief, "codeden");
      return delay({ sessionId: id }, 400);
    },
    queue: queue.api({
      running: (sessionId) => running.has(sessionId),
      steer: (sessionId, input) => client.sendMessage(sessionId, input, "steer"),
    }),
    async archiveSession(sessionId) {
      running.get(sessionId)?.cancel();
      const now = new Date().toISOString();
      const before = world.snapshot.sessions.find((s) => s.id === sessionId);
      if (!before) throw new Error("Session not found");
      world.updateSession(sessionId, {
        status: before.status === "running" ? "stopped" : before.status,
        archivedAt: now,
        worktreeRemovedAt: before.worktreePath ? now : null,
      });
      const session = world.snapshot.sessions.find((s) => s.id === sessionId) ?? before;
      return {
        session,
        worktree: { status: before.worktreePath ? "removed" : "none", message: null },
      };
    },
    async unarchiveSession(sessionId) {
      world.updateSession(sessionId, { archivedAt: null });
      const session = world.snapshot.sessions.find((s) => s.id === sessionId);
      if (!session) throw new Error("Session not found");
      return session;
    },

    async resolveInbox(itemId, resolution) {
      const item = world.snapshot.inbox.find((i) => i.id === itemId);
      if (!item) throw new Error("Inbox item not found");
      const now = new Date().toISOString();
      const next = {
        ...item,
        resolvedAt: now,
        updatedAt: now,
        status: resolution.status ?? ("resolved" as const),
        resolution: resolution.note ? { note: resolution.note } : null,
      };
      world.emitDomain({ type: "inbox.updated", sessionId: null, payload: { item: next } });
      return next;
    },

    ...mockProjectApi(world),
    automations: mockAutomationsApi(world),
    factory: mockFactoryApi(world),

    async updateSettings(patch: SettingsPatch) {
      const settings = Settings.parse(deepMerge(world.snapshot.settings, patch));
      world.emitDomain({ type: "settings.updated", sessionId: null, payload: { settings } });
      return settings;
    },
    ...workbenchApi(world),
    ...mockFeatureApis(world),
    ...mockOrchestration(world, {
      sendMessage: (id, input, mode) => client.sendMessage(id, input, mode),
      createSession,
    }),
  };
  return client;
}
