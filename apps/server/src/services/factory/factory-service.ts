import {
  type FactoryCandidate,
  type FactoryDecisionRequest,
  type FactoryDigest,
  type FactoryItem,
  type FactoryLoop,
  type FactoryStatus,
  type FactoryTriageRequest,
  isFactoryMode,
  type KillSwitchResponse,
  type Project,
  type RawEventEnvelope,
  type ReviewVerdict,
  type Session,
  type SetAutonomyModeRequest,
  type SetAutonomyModeResponse,
  type VisionResponse,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { badRequest, conflict, errorMessage, notFound } from "../errors";
import type { Exec } from "../exec";
import type { InboxService } from "../inbox-service";
import type { NoticeDraft } from "../orchestration/notices";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { budgetSpend, type FactoryContext, factoryNotice, raiseInbox } from "./context";
import * as decisions from "./decisions";
import { buildDigest } from "./digest";
import type { FactoryGithub } from "./github-port";
import { runTick } from "./loop";
import { hasBudget, localDay } from "./policy";
import { FactorySessions, isFactorySession } from "./sessions";
import { buildStatus } from "./status";
import { FactoryStore } from "./store";
import { answerProviderQuestion, recordDecision, unattendedSession } from "./unattended";
import { readVision, writeVision } from "./vision";

export interface FactoryOptions {
  /** Interval of the background tick (default 30 s). */
  tickMs?: number;
  /** Run the loop in the background (default true; tests drive `tick` by hand). */
  autoTick?: boolean;
  /** How long a PR may report no CI before it counts as missing (default 3 minutes). */
  ciGraceMs?: number;
  now?: () => Date;
}

export interface FactoryServiceDeps {
  db: Db;
  store: EventStore;
  projects: ProjectService;
  repo: SessionRepo;
  sessions: SessionService;
  runner: RunnerPort;
  usage: FactoryContext["usage"];
  inbox: InboxService;
  notify: (draft: NoticeDraft, wake?: boolean) => void;
  settings: SettingsStore;
  exec: Exec;
  github: FactoryGithub;
  options?: FactoryOptions;
  log?: (message: string) => void;
}

/**
 * Project autonomy modes and dark-factory mode (§10.1, experimental in v1): modes and limits,
 * the vision, kill switches, the server-driven factory loop, daily digests and the status the
 * factory panel shows. The loop state is persisted, so a restart resumes where it stopped.
 */
export class FactoryService {
  readonly data: FactoryStore;
  readonly ctx: FactoryContext;
  private readonly chains = new Map<string, Promise<FactoryLoop>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private interval: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: FactoryServiceDeps) {
    this.data = new FactoryStore(deps.db, deps.store);
    this.ctx = {
      store: this.data,
      github: deps.github,
      sessions: new FactorySessions({
        sessions: deps.sessions,
        repo: deps.repo,
        runner: deps.runner,
        log: deps.log,
      }),
      projects: deps.projects,
      repo: deps.repo,
      usage: deps.usage,
      inbox: deps.inbox,
      notify: deps.notify,
      settings: deps.settings,
      exec: deps.exec,
      now: deps.options?.now ?? (() => new Date()),
      ciGraceMs: deps.options?.ciGraceMs ?? 3 * 60_000,
      log: deps.log,
    };
  }

  start(): void {
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
    if (this.deps.options?.autoTick === false) return;
    const every = this.deps.options?.tickMs ?? 30_000;
    this.interval ??= setInterval(() => void this.tickAll(), every);
    this.interval.unref?.();
    // Resume loops persisted before a restart.
    this.resumeTimer ??= setTimeout(() => {
      this.resumeTimer = undefined;
      void this.tickAll();
    }, 1_000);
    this.resumeTimer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Run one loop step for a project (serialized per project). */
  tick(projectId: string): Promise<FactoryLoop> {
    const prev = this.chains.get(projectId) ?? Promise.resolve(undefined);
    const next = prev
      .catch(() => undefined)
      .then(() =>
        runTick(this.ctx, projectId, { digest: (p, l, day) => this.writeDigest(p, l, day) }),
      );
    this.chains.set(projectId, next);
    void next
      .catch((error: unknown) =>
        this.deps.log?.(`factory: tick ${projectId}: ${errorMessage(error)}`),
      )
      .finally(() => {
        if (this.chains.get(projectId) === next) this.chains.delete(projectId);
      });
    return next;
  }

  /** Tick every project in a factory mode (and loops that need to wind down). */
  async tickAll(): Promise<void> {
    let projects: ReturnType<FactoryServiceDeps["projects"]["list"]>;
    try {
      projects = this.deps.projects.list();
    } catch (error) {
      // Stopping: the database may already be closed.
      this.deps.log?.(`factory: listing projects: ${errorMessage(error)}`);
      return;
    }
    for (const p of projects) {
      if (!isFactoryMode(p.autonomyMode) && !this.data.loop(p.id)) continue;
      await this.tick(p.id).catch(() => undefined);
    }
  }

  /** Schedule a tick soon (debounced), e.g. after a factory session changed. */
  soon(projectId: string, delayMs = 500): void {
    if (this.deps.options?.autoTick === false) return;
    if (this.timers.has(projectId)) return;
    const t = setTimeout(() => {
      this.timers.delete(projectId);
      void this.tick(projectId).catch(() => undefined);
    }, delayMs);
    t.unref?.();
    this.timers.set(projectId, t);
  }

  // ------------------------------------------------------------ modes, vision, switches

  status(projectId: string): FactoryStatus {
    return buildStatus(this.ctx, projectId);
  }

  vision(projectId: string): VisionResponse {
    return readVision(this.deps.projects.get(projectId));
  }

  /**
   * Save the vision in the main checkout (the factory reads it from there), then, in a GitHub
   * project, commit it through a small PR (`codeden/vision`) so agent worktrees get it too.
   * A failed commit keeps the local save and reports `shareError`.
   */
  async putVision(projectId: string, contents: string): Promise<VisionResponse> {
    const project = this.deps.projects.get(projectId);
    const saved = writeVision(project, contents);
    if (project.kind !== "github" || !this.ctx.github.isGithubProject(projectId)) return saved;
    try {
      const path = project.visionPath.replaceAll("\\", "/").replace(/^\.\//, "");
      const pr = await this.ctx.github.shareVision(projectId, path, saved.contents);
      return { ...saved, pr, shareError: null };
    } catch (error) {
      this.deps.log?.(`factory: committing the vision: ${errorMessage(error)}`);
      return { ...saved, pr: null, shareError: errorMessage(error) };
    }
  }

  /**
   * Change the autonomy mode. Autopilot and dark factory need a GitHub project, a vision file
   * and limits with a daily budget (in the request, or saved while already in a factory mode).
   */
  setMode(projectId: string, req: SetAutonomyModeRequest): SetAutonomyModeResponse {
    const project = this.deps.projects.get(projectId);
    const entering = isFactoryMode(req.mode);
    const wasFactory = isFactoryMode(project.autonomyMode);
    const limits = req.limits ?? project.factoryLimits;
    if (entering) {
      if (!this.ctx.github.isGithubProject(projectId)) {
        throw conflict("Autopilot and dark factory need a GitHub project", "not_a_github_project");
      }
      if (!readVision(project).exists) {
        throw conflict(`Write the project vision (${project.visionPath}) first`, "vision_required");
      }
      if (!req.limits && !wasFactory) {
        throw badRequest("Set the factory limits when switching to this mode", "limits_required");
      }
      if (!hasBudget(limits)) {
        throw badRequest("The limits need a daily budget (usd or tokens)", "budget_required");
      }
    }
    const next = {
      ...project,
      autonomyMode: req.mode,
      factoryLimits: limits,
      updatedAt: new Date().toISOString(),
    } as Project;
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    this.data.saveLoop({
      ...loop,
      tuning: { ...loop.tuning, ...req.tuning },
      ...(entering && !wasFactory
        ? {
            enabledAt: this.ctx.now().toISOString(),
            consecutiveFailures: 0,
            pausedReason: null,
            state: "idle" as const,
          }
        : {}),
      ...(!entering ? { state: "idle" as const, discovery: [] } : {}),
    });
    this.soon(projectId);
    return { projectId, mode: req.mode, limits, experimental: entering };
  }

  /** The project kill switch: on stops the loop and every factory session at once. */
  async setKillSwitch(projectId: string, on: boolean): Promise<KillSwitchResponse> {
    const project = this.deps.projects.get(projectId);
    if (project.killSwitch !== on) {
      const next = { ...project, killSwitch: on, updatedAt: new Date().toISOString() } as Project;
      this.deps.store.append([
        { type: "project.updated", sessionId: null, payload: { project: next } },
      ]);
    }
    const stoppedSessions = on ? await this.halt(projectId) : [];
    if (!on) this.resumeAfterKill(projectId);
    return { on, stoppedSessions };
  }

  /** The global kill switch (`settings.factory.killSwitch`): stops every project's loop. */
  async setGlobalKillSwitch(on: boolean): Promise<KillSwitchResponse> {
    const settings = this.deps.settings.update({ factory: { killSwitch: on } });
    this.deps.store.append([{ type: "settings.updated", sessionId: null, payload: { settings } }]);
    const stoppedSessions: string[] = [];
    for (const p of this.deps.projects.list()) {
      if (on) stoppedSessions.push(...(await this.halt(p.id)));
      else if (!p.killSwitch && this.data.loop(p.id)) this.resumeAfterKill(p.id);
    }
    return { on, stoppedSessions };
  }

  /** Resume a paused loop (resets the failure count). */
  resume(projectId: string): FactoryLoop {
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    const next = this.data.saveLoop({
      ...loop,
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
    });
    const paused = this.deps.inbox.find(`inbox:factory-paused:${projectId}`);
    if (paused?.status === "open") this.deps.inbox.close(paused, "resolved", { note: "resumed" });
    this.soon(projectId);
    return next;
  }

  item(projectId: string, itemId: string): FactoryItem {
    const item = this.data.item(itemId);
    if (!item || item.projectId !== projectId)
      throw notFound(`No factory item ${itemId}`, "item_not_found");
    return item;
  }

  /** Write today's digest now (the loop writes one per day on its own). */
  async digestNow(projectId: string): Promise<FactoryDigest> {
    const project = this.deps.projects.get(projectId);
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    return this.writeDigest(project, loop, localDay(this.ctx.now()));
  }

  // ------------------------------------------------------------ judgement inputs (tools)

  reportCandidates(session: Session, candidates: FactoryCandidate[]) {
    const res = decisions.reportCandidates(this.ctx, session, candidates);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  async triage(projectId: string, req: FactoryTriageRequest): Promise<FactoryItem> {
    const item = await decisions.triage(this.ctx, projectId, req);
    this.soon(projectId);
    return item;
  }

  submitReview(session: Session, verdict: ReviewVerdict) {
    const res = decisions.submitReview(this.ctx, session, verdict);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_record_decision`: a decision an unattended agent made instead of asking. */
  recordDecision(session: Session, req: FactoryDecisionRequest) {
    return recordDecision(this.ctx, session, req);
  }

  /** True when nobody answers this session's questions (dark factory PM or factory agent). */
  isUnattended(sessionId: string): boolean {
    return unattendedSession(this.ctx, sessionId) !== undefined;
  }

  // ------------------------------------------------------------ internals

  private async halt(projectId: string): Promise<string[]> {
    const stopped = await this.ctx.sessions.stopAll(projectId);
    for (const item of this.data.items(projectId, ["building", "verifying"])) {
      this.data.updateItem(item.id, (i) =>
        i.stage === "building" && !i.pr
          ? { ...i, stage: "backlog", builderSessionId: null, note: "Stopped by the kill switch" }
          : {
              ...i,
              reviewerSessionId: i.review ? i.reviewerSessionId : null,
              note: "Stopped by the kill switch",
            },
      );
    }
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    this.data.saveLoop({ ...loop, state: "stopped", discovery: [] });
    return stopped;
  }

  private resumeAfterKill(projectId: string): void {
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    if (loop.state === "stopped") this.data.saveLoop({ ...loop, state: "idle" });
    this.soon(projectId);
  }

  private async writeDigest(
    project: Project,
    loop: FactoryLoop,
    day: string,
  ): Promise<FactoryDigest> {
    const items = this.data
      .items(project.id)
      .filter((i) => localDay(new Date(i.updatedAt)) === day);
    const digest = buildDigest({
      projectId: project.id,
      projectName: project.name,
      day,
      items,
      escalated: this.data.items(project.id, ["escalated"]),
      inbox: this.deps.inbox.list({ projectId: project.id }),
      spend: budgetSpend(this.ctx, project.id, day, project.factoryLimits),
      limits: project.factoryLimits,
      pausedReason: loop.state === "paused" ? loop.pausedReason : null,
      now: this.ctx.now(),
    });
    this.data.saveDigest(digest);
    raiseInbox(this.ctx, {
      id: `inbox:factory-digest:${project.id}:${day}`,
      kind: "automation_result",
      priority: "low",
      projectId: project.id,
      title: `Factory digest: ${project.name}, ${day} (${digest.shipped.length} shipped, ${digest.rejected.length} rejected, ${digest.waiting.length} waiting)`,
      body: digest.text,
    });
    factoryNotice(this.ctx, {
      id: `factory.digest:${digest.id}`,
      projectId: project.id,
      target: "orchestrator",
      event: "digest",
      title: `Factory digest for ${project.name} (${day})`,
      text: digest.text,
      wake: false,
    });
    return digest;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type === "agent.item.started") {
        if ((e.payload as { item?: { kind?: string } }).item?.kind !== "user_question") continue;
        // After the current append: answering appends events of its own.
        setImmediate(
          () =>
            void answerProviderQuestion(
              this.ctx,
              (id, req) => this.deps.sessions.respond(id, req),
              e,
            ),
        );
      } else if (e.type === "session.updated") {
        const { session } = e.payload as { session: Session };
        if (session.projectId && isFactorySession(session)) this.soon(session.projectId);
      } else if (e.type.startsWith("pr.")) {
        const { pr } = e.payload as { pr: { projectId: string } };
        if (this.inFactoryMode(pr.projectId)) this.soon(pr.projectId);
      }
    }
  }

  private inFactoryMode(projectId: string): boolean {
    try {
      return isFactoryMode(this.deps.projects.get(projectId).autonomyMode);
    } catch {
      return false;
    }
  }
}
