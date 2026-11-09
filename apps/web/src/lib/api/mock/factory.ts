import {
  type FactoryItem,
  FactoryLimits,
  FactoryLoop,
  FactoryStatus,
  FactoryTuning,
  type FactoryWorkItem,
  isFactoryMode,
  parseVision,
} from "@codeden/contracts";
import type { FactoryApi } from "../factory-api";
import type { FixtureWorkItem } from "./fixtures/factory-fixture-types";
import { defaultFactoryLimits, factoryFor, visionDoc } from "./fixtures/ops";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const now = () => new Date().toISOString();

function work(w: FixtureWorkItem): FactoryWorkItem {
  return {
    id: w.id,
    title: w.title,
    workKey: w.workKey,
    issue: w.issue,
    pr: w.pr,
    score: w.score ?? null,
    sessionId: w.sessionId ?? null,
    stage: w.stage,
    source: w.workKey.startsWith("issue:") ? "issue" : "discovery",
    reason: w.stage === "rejected" ? "Out of scope for the vision" : null,
    note: null,
    updatedAt: now(),
  };
}

/** In-memory factory API over the mock world's fixtures (§10.1). */
export function mockFactoryApi(world: MockWorld): FactoryApi {
  const visions = new Map<string, string>();
  const project = (id: string) => world.snapshot.projects.find((p) => p.id === id);
  const status = (projectId: string): FactoryStatus => {
    const cached = world.factory.get(projectId);
    if (cached) return cached;
    const p = project(projectId);
    const f = factoryFor(
      projectId,
      p?.autonomyMode ?? "assisted",
      p?.factoryLimits ?? defaultFactoryLimits,
    );
    const s = FactoryStatus.parse({
      ...f,
      experimental: isFactoryMode(f.mode),
      pausedReason: null,
      globalKillSwitch: world.snapshot.settings.factory.killSwitch,
      tuning: FactoryTuning.parse({}),
      activeSessions: f.inProgress.length,
      backlog: f.backlog.map(work),
      inProgress: f.inProgress.map(work),
      recent: f.recent.map(work),
      mergeChecks: f.mergeChecks.map((c, i) => ({
        itemId: f.inProgress[i]?.id ?? `fw-c${i}`,
        prNumber: c.prNumber,
        title: c.title,
        checks: c.checks.map((x) => ({ ...x, detail: x.detail ?? null, at: now() })),
        reviewerProvider: "codex",
        reviewerNote: null,
        verdict: null,
      })),
      lastDigest: null,
      lastTickAt: now(),
    });
    world.factory.set(projectId, s);
    return s;
  };
  const item = (projectId: string, itemId: string): FactoryItem => {
    const s = status(projectId);
    const w = [...s.backlog, ...s.inProgress, ...s.recent].find((x) => x.id === itemId);
    if (!w) throw new Error(`No factory item ${itemId}`);
    return {
      ...w,
      projectId,
      summary: `Work item "${w.title}" from the ${w.source}.`,
      area: null,
      acceptanceCriteria: ["Behaviour covered by tests", "No visual regressions"],
      builderSessionId: w.sessionId,
      builderProvider: "claude",
      reviewerSessionId: null,
      reviewerProvider: "codex",
      reviewerNote: null,
      review: null,
      checks: s.mergeChecks.find((c) => c.itemId === itemId)?.checks ?? [],
      attempts: 0,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      nudges: {},
      createdAt: w.updatedAt,
      mergedAt: w.stage === "merged" ? w.updatedAt : null,
      finishedAt: null,
    };
  };
  const loop = (projectId: string) =>
    FactoryLoop.parse({
      projectId,
      state: status(projectId).loopState,
      pausedReason: null,
      consecutiveFailures: 0,
      day: now().slice(0, 10),
      mergesToday: status(projectId).mergesToday,
      discovery: [],
      nextArea: 0,
      lastDiscoveryAt: null,
      lastDigestDay: null,
      enabledAt: null,
      lastTickAt: now(),
      updatedAt: now(),
    });

  return {
    status: (id) => delay(status(id), 140),
    item: (id, itemId) => delay(item(id, itemId)),
    async setMode(projectId, req) {
      const p = project(projectId);
      if (!p) throw new Error(`No project ${projectId}`);
      const limits = FactoryLimits.parse(req.limits ?? p.factoryLimits);
      world.emitDomain({
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...p, autonomyMode: req.mode, factoryLimits: limits } },
      });
      world.factory.delete(projectId);
      return { projectId, mode: req.mode, limits, experimental: isFactoryMode(req.mode) };
    },
    async vision(projectId) {
      const contents = visions.get(projectId) ?? visionDoc;
      const path = project(projectId)?.visionPath ?? ".codeden/VISION.md";
      return { path, exists: true, contents, parsed: parseVision(contents) };
    },
    async saveVision(projectId, contents) {
      visions.set(projectId, contents);
      const path = project(projectId)?.visionPath ?? ".codeden/VISION.md";
      return { path, exists: true, contents, parsed: parseVision(contents) };
    },
    async killSwitch(scope, on) {
      if (scope === "global") {
        const settings = { ...world.snapshot.settings, factory: { killSwitch: on } };
        world.emitDomain({ type: "settings.updated", sessionId: null, payload: { settings } });
        world.factory.clear();
        return { on, stoppedSessions: [] };
      }
      const s = status(scope.projectId);
      world.factory.set(scope.projectId, {
        ...s,
        killSwitch: on,
        loopState: on ? "stopped" : "building",
      });
      const p = project(scope.projectId);
      if (p)
        world.emitDomain({
          type: "project.updated",
          sessionId: null,
          payload: { project: { ...p, killSwitch: on } },
        });
      return { on, stoppedSessions: [] };
    },
    resume: (id) => delay(loop(id)),
    tick: (id) => delay(status(id)),
    async digest(projectId) {
      return {
        id: `digest-${projectId}`,
        projectId,
        day: now().slice(0, 10),
        shipped: [],
        rejected: [],
        spend: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
        waiting: [],
        decisions: [],
        text: "Nothing shipped yet today.",
        createdAt: now(),
      };
    },
    triage: async (id, req) => item(id, req.itemId),
  };
}
