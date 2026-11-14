import {
  FactoryLimits,
  type FactoryPrEntry,
  FactoryStatus,
  type FactoryWorkItem,
  type ScoutStatus,
} from "@codeden/contracts";
import type { AgentInputs } from "@/components/factory-view/pixel/agents";
import { type SessionInfo, viewPipeline } from "@/components/factory-view/stages";

/** Builders for the pixel mode tests (#209, #264): work items, PR entries, a status. */

export const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime();
export const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

export const prRef = (n: number, state: "open" | "merged" | "closed" = "open") => ({
  number: n,
  url: `https://github.com/acme/shop/pull/${n}`,
  state,
});

export function w(id: string, n: number, patch: Partial<FactoryWorkItem>): FactoryWorkItem {
  return {
    id,
    title: `Item ${n}`,
    workKey: `issue:${n}`,
    issue: { number: n, url: `https://github.com/acme/shop/issues/${n}` },
    pr: null,
    score: null,
    sessionId: null,
    reviewerSessionId: null,
    activeSessionId: null,
    stage: "building",
    step: "implement",
    type: "feature",
    trust: "trusted",
    author: "octocat",
    source: "issue",
    attempts: 0,
    reason: null,
    note: null,
    failureKind: null,
    stepSince: minutesAgo(10),
    mergedAt: null,
    finishedAt: null,
    checks: null,
    ownedPr: null,
    recovering: false,
    updatedAt: minutesAgo(1),
    ...patch,
  };
}

export const prEntry = (
  itemId: string,
  n: number,
  patch: Partial<FactoryPrEntry>,
): FactoryPrEntry => ({
  itemId,
  title: `PR ${n}`,
  pr: prRef(n),
  state: "checking",
  queuePosition: null,
  note: null,
  ...patch,
});

export const scoutStatus: ScoutStatus = {
  phase: "reviewing",
  sessionId: "scout",
  lenses: [
    { area: "ux", sessionId: "l1", reported: true, active: false },
    { area: "performance", sessionId: "l2", reported: false, active: true },
    { area: "security", sessionId: "l3", reported: false, active: false },
  ],
  findings: 3,
  filed: 1,
  lastRoundAt: null,
  nextRoundAt: null,
  rounds: 4,
  runNowBlockedBy: null,
};

export function status(patch: Partial<FactoryStatus> = {}): FactoryStatus {
  return FactoryStatus.parse({
    projectId: "p1",
    mode: "dark_factory",
    experimental: true,
    loopState: "building",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 }, autoMerge: true }),
    tuning: {},
    spendToday: { usd: 12, tokens: 900_000 },
    mergesToday: 2,
    stats: { mergedToday: 7 },
    consecutiveFailures: 0,
    activeSessions: 2,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
    scout: scoutStatus,
    ...patch,
  });
}

/** A running session that reported progress `m` minutes ago. */
export const running = (
  progress: string | null,
  m: number,
  more: Partial<SessionInfo> = {},
): SessionInfo => ({
  status: "running",
  progress,
  progressAt: progress ? minutesAgo(m) : null,
  provider: "Claude Code",
  model: "opus",
  workKey: "issue:1",
  ...more,
});

/** The inputs of the agents model for a status, its sessions and the PM's session id. */
export function inputs(
  f: FactoryStatus,
  sessions: ReadonlyMap<string, SessionInfo> = new Map(),
  pmSessionId: string | null = null,
): AgentInputs {
  return { f, pipeline: viewPipeline(f, sessions, NOW), sessions, pmSessionId };
}
