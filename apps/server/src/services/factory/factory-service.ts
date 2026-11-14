import {
  type FactoryAdmitRequest,
  type FactoryAllowLargeChangeRequest,
  type FactoryAnalysisReport,
  type FactoryDecisionRequest,
  type FactoryDigest,
  type FactoryDismissRequest,
  type FactoryFileIssueRequest,
  type FactoryFinding,
  type FactoryItem,
  type FactoryLoop,
  type FactoryPlanRoundRequest,
  type FactoryReproductionReport,
  type FactoryRetryMode,
  type FactorySetTypeRequest,
  type FactoryStatus,
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
import { errorMessage, notFound } from "../errors";
import type { Exec } from "../exec";
import type { InboxService } from "../inbox-service";
import type { NoticeDraft } from "../orchestration/notices";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { flagAllowList, isAllowListNotice } from "./allow-lists";
import { ProviderAvailability } from "./availability";
import { SessionArchiver } from "./cleanup";
import type { FactoryContext } from "./context";
import { assertCanEnter, haltProject } from "./controls";
import * as decisions from "./decisions";
import { writeDigest } from "./digest";
import type { FactoryGithub } from "./github-port";
import { allowLargeChange } from "./large-change";
import { runTick } from "./loop";
import { PrFiles } from "./overlap";
import { reportReproduction, submitAnalysis } from "./pipeline";
import { localDay } from "./policy";
import { runScoutNow } from "./scout";
import { fileIssue, planRound, reportFindings } from "./scout-reports";
import {
  FactorySessions,
  isFactorySession,
  LENS_WORK_KEY_PREFIX,
  SCOUT_WORK_KEY,
} from "./sessions";
import { SlotBoard } from "./slots";
import { buildStatus } from "./status";
import { FactoryStore } from "./store";
import { answerProviderQuestion, recordDecision, unattendedSession } from "./unattended";
import { readVision, writeVision } from "./vision";

export interface FactoryOptions {
  /** Interval of the background tick (default 30 s). */
  tickMs?: number;
  /** Run the loop in the background (default true; tests drive `tick` by hand). */
  autoTick?: boolean;
  /** How long CI may take to start on a new head commit before it counts as never started (default 10 minutes). */
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
  /** The utility model, for the "Identify type" step (keywords decide without it). */
  complete?: (job: string, system: string, prompt: string) => Promise<string | null>;
  /** The session archive path (`WorktreeCleanup.archive`): hides it and removes its worktree. */
  archiveSession: (sessionId: string) => Promise<unknown>;
  options?: FactoryOptions;
  log?: (message: string) => void;
}

/**
 * Project autonomy modes, the software factory and the dark factory (§10.1, experimental):
 * modes and limits, the vision, kill switches, the server-driven factory loop with its
 * pipelines and the dark factory's scout, daily digests and the status the factory panel and
 * its pipeline diagram show. The loop state is persisted, so a restart resumes where it stopped.
 */
export class FactoryService {
  readonly data: FactoryStore;
  readonly ctx: FactoryContext;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Archives finished work's sessions, one at a time, outside the tick chains. */
  readonly archiver: SessionArchiver;
  private interval: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: FactoryServiceDeps) {
    this.data = new FactoryStore(deps.db, deps.store);
    this.archiver = new SessionArchiver({
      repo: deps.repo,
      archive: deps.archiveSession,
      log: deps.log,
    });
    this.ctx = {
      store: this.data,
      github: deps.github,
      sessions: new FactorySessions({
        sessions: deps.sessions,
        repo: deps.repo,
        runner: deps.runner,
        availability: new ProviderAvailability({
          runner: deps.runner,
          rateLimits: () => deps.usage.rateLimitWindows?.() ?? [],
          now: deps.options?.now ?? (() => new Date()),
          log: deps.log,
        }),
        log: deps.log,
      }),
      projects: deps.projects,
      repo: deps.repo,
      usage: deps.usage,
      inbox: deps.inbox,
      notify: deps.notify,
      settings: deps.settings,
      exec: deps.exec,
      complete: deps.complete ?? (async () => null),
      archiveSessions: (ids) => this.archiver.push(ids),
      slots: new SlotBoard(),
      prFiles: new PrFiles(),
      now: deps.options?.now ?? (() => new Date()),
      ciGraceMs: deps.options?.ciGraceMs ?? 10 * 60_000,
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
    return this.serialize(projectId, "tick", () =>
      runTick(this.ctx, projectId, { digest: (p, l, day) => this.writeDigest(p, l, day) }),
    );
  }

  /**
   * Run something that changes a project's loop record after the ticks and reports already
   * queued for it, so two writers never overwrite each other's changes.
   */
  private serialize<T>(projectId: string, what: string, run: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve(undefined);
    const next = prev.catch(() => undefined).then(run);
    this.chains.set(projectId, next);
    void next
      .catch((error: unknown) =>
        this.deps.log?.(`factory: ${what} ${projectId}: ${errorMessage(error)}`),
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

  status(projectId: string): Promise<FactoryStatus> {
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
   * Change the autonomy mode. The software and dark factory need a GitHub project, a vision
   * file and limits with a daily budget (in the request, or saved while already in a factory
   * mode); a request without them throws at once. The tuning in the request is merged into the
   * saved one after the ticks already queued, so a tick in flight never overwrites it.
   */
  setMode(projectId: string, req: SetAutonomyModeRequest): Promise<SetAutonomyModeResponse> {
    const project = this.deps.projects.get(projectId);
    const entering = isFactoryMode(req.mode);
    const wasFactory = isFactoryMode(project.autonomyMode);
    const limits = req.limits ?? project.factoryLimits;
    if (entering)
      assertCanEnter(this.ctx, project, { limitsSent: Boolean(req.limits), wasFactory, limits });
    const next = {
      ...project,
      autonomyMode: req.mode,
      factoryLimits: limits,
      updatedAt: new Date().toISOString(),
    } as Project;
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
    const saved = this.serialize(projectId, "set mode", () => {
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
        ...(!entering ? { state: "idle" as const, scout: { ...loop.scout, round: null } } : {}),
      });
    });
    this.soon(projectId);
    return saved.then(() => ({ projectId, mode: req.mode, limits, experimental: entering }));
  }

  /**
   * "Run scout now" (dark factory): start a scout round right away, skipping the interval and
   * the backlog threshold. Throws `scout_unavailable` (409) with the reason when it can't.
   */
  async runScout(projectId: string): Promise<FactoryLoop> {
    const loop = await this.serialize(projectId, "run scout", async () => {
      const project = this.deps.projects.get(projectId);
      const current = this.data.loopOrNew(projectId, this.ctx.now());
      return this.data.saveLoop(await runScoutNow(this.ctx, project, current));
    });
    this.soon(projectId);
    return loop;
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

  // ------------------------------------------------------------ decisions (UI, PM)

  /** Let an ignored issue from an untrusted author in (never merged automatically). */
  async admit(
    projectId: string,
    req: FactoryAdmitRequest,
    by: decisions.DecidedBy,
  ): Promise<FactoryItem> {
    const item = await decisions.admit(this.ctx, projectId, req, by);
    this.soon(projectId);
    return item;
  }

  /** Correct the type of an item that hasn't started. */
  async setType(
    projectId: string,
    req: FactorySetTypeRequest,
    by: decisions.DecidedBy,
  ): Promise<FactoryItem> {
    const item = await decisions.setType(this.ctx, projectId, req, by);
    this.soon(projectId);
    return item;
  }

  /**
   * Run a stopped item again: its open PR back to review (`rereview`, the default while it is
   * open), or a fresh attempt from the first step (`rebuild`).
   */
  retry(
    projectId: string,
    itemId: string,
    mode?: FactoryRetryMode,
    by: decisions.DecidedBy = "user",
  ): FactoryItem {
    const item = decisions.retry(this.ctx, projectId, itemId, mode, by);
    this.soon(projectId);
    return item;
  }

  /** Dismiss a failed item without an open PR: it is rejected with the reason. */
  dismiss(
    projectId: string,
    itemId: string,
    req: FactoryDismissRequest,
    by: decisions.DecidedBy,
  ): FactoryItem {
    const item = decisions.dismiss(this.ctx, projectId, itemId, req, by);
    this.soon(projectId);
    return item;
  }

  // ------------------------------------------------------------ agents' reports (tools)

  /** `factory_report_reproduction`; the answer is the builder's next step. */
  async reportReproduction(session: Session, report: FactoryReproductionReport) {
    const res = await reportReproduction(this.ctx, session, report);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_submit_analysis`; the answer is the builder's next step. */
  async submitAnalysis(session: Session, report: FactoryAnalysisReport) {
    const res = await submitAnalysis(this.ctx, session, report);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_plan_round`: the scout's review areas for this round. */
  planRound(session: Session, req: FactoryPlanRoundRequest) {
    const projectId = session.projectId ?? "";
    return this.serialize(projectId, "plan round", () => planRound(this.ctx, session, req));
  }

  /** `factory_report_findings`: an area reviewer's findings. */
  async reportFindings(session: Session, findings: FactoryFinding[]) {
    const projectId = session.projectId ?? "";
    const res = await this.serialize(projectId, "findings", () =>
      reportFindings(this.ctx, session, findings),
    );
    this.soon(projectId);
    return res;
  }

  /** `factory_file_issue`: the scout files one piece of work. */
  async fileIssue(session: Session, req: FactoryFileIssueRequest) {
    const projectId = session.projectId ?? "";
    const res = await this.serialize(projectId, "file issue", () =>
      fileIssue(this.ctx, session, req),
    );
    this.soon(projectId);
    return res;
  }

  /** Whether a session is a factory builder (it may report a reproduction or analysis). */
  isBuilder(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    if (!s?.projectId || !isFactorySession(s)) return false;
    return this.data.items(s.projectId, ["building"]).some((i) => i.builderSessionId === s.id);
  }

  /** Whether a session is the dark factory's scout. */
  isScout(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    return s !== undefined && isFactorySession(s) && s.workKey === SCOUT_WORK_KEY;
  }

  /** Whether a session is one of the scout's area reviewers (lenses). */
  isLens(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    return s !== undefined && isFactorySession(s) && s.workKey.startsWith(LENS_WORK_KEY_PREFIX);
  }

  submitReview(session: Session, verdict: ReviewVerdict) {
    const { forward, ...res } = decisions.submitReview(this.ctx, session, verdict);
    // A verdict that came after a revise round started: its findings go to the author.
    if (forward) {
      this.ctx.sessions
        .message(forward.sessionId, forward.text)
        .catch((error: unknown) =>
          this.deps.log?.(`factory: late review to ${forward.sessionId}: ${errorMessage(error)}`),
        );
    }
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_allow_large_change`: the PM lets an item over the size limit merge. */
  allowLargeChange(projectId: string, req: FactoryAllowLargeChangeRequest): FactoryItem {
    const item = allowLargeChange(this.ctx, projectId, req);
    this.soon(projectId);
    return item;
  }

  /** `factory_record_decision`: a decision an unattended agent made instead of asking. */
  recordDecision(session: Session, req: FactoryDecisionRequest) {
    return recordDecision(this.ctx, { projectId: session.projectId, sessionId: session.id }, req);
  }

  /** True when nobody answers this session's questions (dark factory PM or factory agent). */
  isUnattended(sessionId: string): boolean {
    return unattendedSession(this.ctx, sessionId) !== undefined;
  }

  // ------------------------------------------------------------ internals

  private halt(projectId: string): Promise<string[]> {
    return haltProject(this.ctx, projectId);
  }

  private resumeAfterKill(projectId: string): void {
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    if (loop.state === "stopped") this.data.saveLoop({ ...loop, state: "idle" });
    this.soon(projectId);
  }

  private writeDigest(project: Project, loop: FactoryLoop, day: string): Promise<FactoryDigest> {
    return writeDigest(this.ctx, this.deps.inbox, project, loop, day);
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
      } else if (isAllowListNotice(e)) {
        // After the current append: it appends the item's change and an inbox item.
        setImmediate(() => {
          try {
            flagAllowList(this.ctx, e);
          } catch (error) {
            this.deps.log?.(`factory: allow-list warning: ${errorMessage(error)}`);
          }
        });
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
