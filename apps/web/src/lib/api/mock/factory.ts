import {
  AutonomyMode,
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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const FINISHED = ["merged", "reverted", "rejected", "failed", "escalated"];
const OWNING = ["backlog", "building", "verifying", "escalated", "failed"];

function work(w: FixtureWorkItem): FactoryWorkItem {
  const done = ["merged", "reverted", "rejected"].includes(w.stage);
  const since = minutesAgo(w.stepMinutesAgo ?? 4);
  return {
    id: w.id,
    title: w.title,
    workKey: w.workKey,
    issue: w.issue,
    pr: w.pr,
    score: w.score ?? null,
    sessionId: w.sessionId ?? null,
    reviewerSessionId: null,
    activeSessionId: w.sessionId ?? null,
    stage: w.stage,
    step: w.step ?? (done ? (w.stage === "merged" ? "done" : "stopped") : "queued"),
    type: w.type ?? (done ? "feature" : null),
    trust: w.trust ?? "trusted",
    author: w.author ?? "hearth-co",
    source: w.workKey.startsWith("issue:") ? "issue" : "discovery",
    attempts: w.attempts ?? 0,
    reason:
      w.reason ??
      (w.stage === "rejected"
        ? "Out of scope for the vision"
        : w.stage === "ignored"
          ? `Opened by @${w.author ?? "someone"}, who is not a trusted author`
          : null),
    note:
      w.note ??
      (w.stage === "verifying" && w.step === "merge"
        ? "Ready to merge: every check passed (auto-merge is off)"
        : null),
    failureKind: w.failureKind ?? null,
    // Owned while open, in the stages the factory keeps its PRs.
    ownedPr:
      OWNING.includes(w.stage) && (w.pr?.state === "open" || w.pr?.state === "draft") ? w.pr : null,
    checks: w.checks ?? null,
    stepSince: since,
    mergedAt: w.stage === "merged" || w.stage === "watching" ? since : null,
    finishedAt: FINISHED.includes(w.stage) ? since : null,
    updatedAt: since,
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
      activeSessions: Math.min(f.inProgress.length, f.limits.maxConcurrentSessions),
      // The work-in-progress limit follows the agent limit (no `maxOpenPrs` set).
      wip: {
        openPrs: f.inProgress.filter((w) => w.pr).length,
        limit: f.limits.maxConcurrentSessions,
        holding: f.inProgress.filter((w) => w.pr).length >= f.limits.maxConcurrentSessions,
      },
      backlog: f.backlog.map(work),
      inProgress: f.inProgress.map(work).map((w) => {
        // Check counts from the fixture's merge checks of the same pull request.
        const c = f.mergeChecks.find((m) => m.prNumber === w.pr?.number)?.checks;
        if (!c) return w;
        const passed = c.filter((x) => x.state === "pass" || x.state === "skipped").length;
        const failed = c.filter((x) => x.state === "fail").length;
        return { ...w, checks: { passed, failed, total: c.length } };
      }),
      recent: f.recent.map(work),
      // What a server keeps for the view beyond the capped recent list.
      viewRecent: f.recent
        .map(work)
        .filter((w) => ["escalated", "failed", "merged"].includes(w.stage)),
      ignored: f.ignored.map(work),
      githubLogin: "hearth-co",
      scout:
        f.mode === "dark_factory"
          ? {
              phase: "reviewing",
              sessionId: "s-audit",
              lenses: [
                { area: "ux", sessionId: "s-a11y", reported: true, active: false },
                { area: "performance", sessionId: "s-search", reported: false, active: true },
              ],
              findings: 3,
              filed: 0,
              lastRoundAt: null,
              nextRoundAt: null,
              rounds: 4,
              runNowBlockedBy: "A scout round is already running.",
            }
          : null,
      stats: { mergedToday: f.mergesToday, ...f.stats },
      mergeChecks: f.mergeChecks.map((c, i) => ({
        itemId: f.inProgress.find((w) => w.pr?.number === c.prNumber)?.id ?? `fw-c${i}`,
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
    const w = [...s.backlog, ...s.inProgress, ...s.recent, ...s.ignored].find(
      (x) => x.id === itemId,
    );
    if (!w) throw new Error(`No factory item ${itemId}`);
    return {
      ...w,
      projectId,
      summary: `Work item "${w.title}" from the ${w.source}.`,
      area: null,
      classification: w.type
        ? { type: w.type, confidence: "high", rationale: "From its label", by: "label", at: now() }
        : null,
      admittedBy: null,
      investigation: null,
      acceptanceCriteria: ["Behaviour covered by tests", "No visual regressions"],
      builderSessionId: w.sessionId,
      builderProvider: "claude",
      reviewerSessionId: null,
      reviewerProvider: "codex",
      reviewerNote: null,
      review: null,
      checks: s.mergeChecks.find((c) => c.itemId === itemId)?.checks ?? [],
      attempts: w.attempts,
      failureKind: w.failureKind,
      rebuiltFrom: null,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      nudges: {},
      largeChange: null,
      sessionsArchivedAt: null,
      earlierSessionIds: [],
      stepSince: w.stepSince,
      createdAt: w.updatedAt,
      mergedAt: w.mergedAt,
      finishedAt: w.finishedAt,
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
      const mode = AutonomyMode.parse(req.mode);
      world.emitDomain({
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...p, autonomyMode: mode, factoryLimits: limits } },
      });
      world.factory.delete(projectId);
      return { projectId, mode, limits, experimental: isFactoryMode(mode) };
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
    async runScout(projectId) {
      const s = status(projectId);
      const blocked =
        s.scout?.runNowBlockedBy ?? (s.scout ? null : "Only a dark factory has a scout.");
      if (blocked) throw new Error(blocked);
      const next: FactoryStatus = {
        ...s,
        scout: s.scout && {
          ...s.scout,
          phase: "planning",
          lenses: [],
          findings: 0,
          filed: 0,
          rounds: s.scout.rounds + 1,
          nextRoundAt: null,
          runNowBlockedBy: "A scout round is already running.",
        },
      };
      world.factory.set(projectId, next);
      return delay(next);
    },
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
    admit: async (id, req) => ({
      ...item(id, req.itemId),
      stage: "candidate",
      trust: "admitted",
      admittedBy: "user",
    }),
    setType: async (id, req) => ({ ...item(id, req.itemId), type: req.type }),
    retry: async (id, itemId) => ({ ...item(id, itemId), stage: "backlog" }),
  };
}
