import type {
  FactoryItem,
  FactoryLimits,
  FactoryLoop,
  GitHubIssueRef,
  GitHubPrRef,
  InboxItem,
  ParsedVision,
  Project,
} from "@codeden/contracts";
import type { SettingsStore } from "../../settings-store";
import type { Exec } from "../exec";
import type { InboxService } from "../inbox-service";
import type { NoticeDraft } from "../orchestration/notices";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "../sessions/repo";
import type { FactoryGithub } from "./github-port";
import type { FactorySessions } from "./sessions";
import type { FactoryStore } from "./store";
import { readVision } from "./vision";

/** Everything the loop steps need; built once by `FactoryService`. */
export interface FactoryContext {
  store: FactoryStore;
  github: FactoryGithub;
  sessions: FactorySessions;
  projects: ProjectService;
  repo: SessionRepo;
  usage: {
    spendSince(
      day: string,
      projectId?: string,
      sessionIds?: ReadonlySet<string>,
    ): { usd: number; tokens: number };
  };
  inbox: InboxService;
  /** Record an orchestration notice (wakes its target unless `wake` is false). */
  notify: (draft: NoticeDraft, wake?: boolean) => void;
  settings: SettingsStore;
  exec: Exec;
  /** One call to the utility model (the "Identify type" step); null when none answered. */
  complete: (job: string, system: string, prompt: string) => Promise<string | null>;
  /**
   * Archive sessions of finished work in the background, in order, which removes their
   * worktrees (see `cleanup.ts`). Sessions gone, archived or busy by then are left alone.
   */
  archiveSessions: (sessionIds: string[]) => void;
  now: () => Date;
  /**
   * How long CI may take to start on a commit (a PR's new head, a merge on the default branch)
   * before "no checks" counts as never started (default 10 minutes).
   */
  ciGraceMs: number;
  log?: (message: string) => void;
}

/** The vision text and its parsed form ("" and empty when the file is missing). */
export function visionOf(project: Project): {
  text: string;
  parsed: ParsedVision;
  exists: boolean;
} {
  try {
    const v = readVision(project);
    return { text: v.exists ? v.contents : "", parsed: v.parsed, exists: v.exists };
  } catch {
    return {
      text: "",
      exists: false,
      parsed: {
        goals: [],
        users: [],
        principles: [],
        outOfScope: [],
        qualityBar: [],
        protectedAreas: { globs: [], topics: [] },
      },
    };
  }
}

/**
 * Raise (or refresh) a factory inbox item. `notify` says whether it needs the user (`needs_you`,
 * `failure`) or is the factory's own activity (`factory`), which toasts only when they ask for it.
 */
export function raiseInbox(
  ctx: FactoryContext,
  item: {
    id: string;
    kind: InboxItem["kind"];
    notify: InboxItem["notify"];
    projectId: string;
    title: string;
    body: string | null;
    priority?: InboxItem["priority"];
    sessionId?: string | null;
    issue?: GitHubIssueRef | null;
    pr?: GitHubPrRef | null;
  },
): void {
  const existing = ctx.inbox.find(item.id);
  if (existing?.status === "open" && existing.title === item.title && existing.body === item.body)
    return;
  const now = ctx.now().toISOString();
  ctx.inbox.put({
    id: item.id,
    kind: item.kind,
    status: "open",
    priority: item.priority ?? "normal",
    notify: item.notify,
    title: item.title,
    body: item.body,
    projectId: item.projectId,
    sessionId: item.sessionId ?? null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: item.issue ?? null,
    pr: item.pr ?? null,
    automationRunId: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  });
}

/** Notice for the PM or the orchestrator about the loop. */
export function factoryNotice(
  ctx: FactoryContext,
  opts: {
    id: string;
    projectId: string;
    target: "pm" | "orchestrator";
    event:
      | "triage_needed"
      | "digest"
      | "paused"
      | "escalated"
      | "regression"
      | "merged"
      | "failed"
      | "ready";
    title: string;
    text: string;
    itemIds?: string[];
    wake?: boolean;
  },
): void {
  ctx.notify(
    {
      id: opts.id,
      type: "factory.update",
      projectId: opts.projectId,
      target: opts.target,
      sessionId: null,
      title: opts.title,
      data: { event: opts.event, text: opts.text, itemIds: opts.itemIds ?? [] },
    },
    opts.wake ?? true,
  );
}

/** Pause the loop (failures, regression, budget) with an inbox item for everything but budget. */
export function pauseLoop(
  ctx: FactoryContext,
  loop: FactoryLoop,
  reason: string,
  opts: { inbox: boolean; items?: FactoryItem[] } = { inbox: true },
): FactoryLoop {
  if (loop.state === "paused" && loop.pausedReason === reason) return loop;
  ctx.log?.(`factory: pausing ${loop.projectId}: ${reason}`);
  const next = { ...loop, state: "paused" as const, pausedReason: reason };
  if (opts.inbox) {
    raiseInbox(ctx, {
      id: `inbox:factory-paused:${loop.projectId}`,
      kind: "run_failed",
      notify: "failure",
      priority: "high",
      projectId: loop.projectId,
      title: "Factory loop paused",
      body: `${reason}. Resume it from the factory panel once you have looked.`,
    });
    factoryNotice(ctx, {
      id: `factory.paused:${loop.projectId}:${ctx.now().toISOString()}`,
      projectId: loop.projectId,
      target: "pm",
      event: "paused",
      title: "Factory loop paused",
      text: `${reason}. No new work starts until the user resumes the loop.`,
      itemIds: opts.items?.map((i) => i.id),
      wake: false,
    });
  }
  return next;
}

/**
 * Spend since `day` that counts against the project's daily factory budget: the factory's own
 * sessions (`budgetScope: "factory"`, the default) or the whole project (`"project"`).
 */
export function budgetSpend(
  ctx: Pick<FactoryContext, "usage" | "sessions">,
  projectId: string,
  day: string,
  limits: FactoryLimits,
): { usd: number; tokens: number } {
  if (limits.budgetScope === "project") return ctx.usage.spendSince(day, projectId);
  const ids = new Set(ctx.sessions.list(projectId).map((s) => s.id));
  return ctx.usage.spendSince(day, projectId, ids);
}
