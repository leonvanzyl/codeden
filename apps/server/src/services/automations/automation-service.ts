import { join } from "node:path";
import type {
  Automation,
  AutomationListItem,
  AutomationListResponse,
  AutomationState,
  Project,
  RawEventEnvelope,
  RunAutomationRequest,
  RunAutomationResponse,
  ScheduledRun,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { conflict, errorMessage, notFound } from "../errors";
import type { InboxService } from "../inbox-service";
import type { OrchestrationService } from "../orchestration/orchestration-service";
import type { AutomationPort } from "../orchestration/ports";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { effectiveTimezone } from "./cron";
import { AutomationDefinitions } from "./definitions";
import {
  factoryOwnsIntake,
  startedByAutomation,
  triggerEvents,
  triggerMatches,
} from "./event-triggers";
import { AutomationExecutor, type FireRequest } from "./executor";
import { baseVars, type TemplateVars } from "./prompt";
import { lastTurnStatus, RunStore } from "./runs";
import { ScheduleStore } from "./schedule-store";
import { CronScheduler, type SchedulePair } from "./scheduler";
import { AutomationSources } from "./sources";
import { type TriageGithub, TriageService } from "./triage";

export interface AutomationServiceDeps {
  db: Db;
  store: EventStore;
  settings: SettingsStore;
  projects: ProjectService;
  sessions: SessionService;
  repo: SessionRepo;
  inbox: InboxService;
  /** Resolved lazily: orchestration is created after this service. */
  orchestration: () => OrchestrationService;
  /** Issue authors and the account CodeDen uses on GitHub, for triage's trust check. */
  github: TriageGithub;
  /** `~/.codeden` (global automation files live in `automations/`). */
  home: string;
  templatesDir?: string;
  /** Clock (tests). */
  now?: () => Date;
  scheduler?: { graceMs?: number; maxWaitMs?: number };
  rescanMs?: number;
  log?: (message: string) => void;
}

const DEFINITION_EVENTS = new Set([
  "automation.saved",
  "automation.deleted",
  "project.created",
  "project.updated",
  "project.archived",
  "settings.updated",
]);

/**
 * Automations (§10): definitions from files and the database, the cron scheduler, event
 * triggers, guards and runs, issue triage, and the `AutomationPort` the PM's scheduling tools
 * and the status digest use (§8.4). Everything is off by default.
 */
export class AutomationService implements AutomationPort {
  readonly runs: RunStore;
  readonly schedules: ScheduleStore;
  readonly sources: AutomationSources;
  readonly definitions: AutomationDefinitions;
  readonly triage: TriageService;
  readonly executor: AutomationExecutor;
  readonly scheduler: CronScheduler;
  /** Session id -> the active run that tracks it. */
  private readonly sessionRuns = new Map<string, string>();
  private unsubscribe: (() => void) | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: AutomationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.runs = new RunStore(deps.db, deps.store);
    // Scheduler state is operational, but live views still need to hear about changes.
    this.schedules = new ScheduleStore(deps.db, (change) =>
      deps.store.append([{ type: "automation.updated", sessionId: null, payload: change }]),
    );
    this.sources = new AutomationSources({
      db: deps.db,
      store: deps.store,
      projects: deps.projects,
      globalDir: join(deps.home, "automations"),
      templatesDir: deps.templatesDir,
      rescanMs: deps.rescanMs,
      log: deps.log,
    });
    this.definitions = new AutomationDefinitions({
      db: deps.db,
      store: deps.store,
      projects: deps.projects,
      sources: this.sources,
      schedules: this.schedules,
    });
    this.triage = new TriageService({
      db: deps.db,
      inbox: deps.inbox,
      sessions: deps.sessions,
      projects: deps.projects,
      orchestration: deps.orchestration,
      github: deps.github,
      triageAutomation: (projectId) => this.triageAutomation(projectId),
      reported: (projectId, issueNumber, decision) =>
        this.executor.completeTriage(projectId, issueNumber, decision),
    });
    this.executor = new AutomationExecutor({
      runs: this.runs,
      sessions: deps.sessions,
      repo: deps.repo,
      orchestration: deps.orchestration,
      triage: this.triage,
      lastTurnStatus: (session) => lastTurnStatus(deps.db, session),
      now: this.now,
      log: deps.log,
    });
    this.scheduler = new CronScheduler({
      store: this.schedules,
      pairs: () => this.pairs(),
      fire: (pair, triggeredBy) =>
        this.fire(this.fireRequest(pair.automation, pair.project, triggeredBy)),
      skipped: (pair) => this.recordPmSkip(pair),
      now: this.now,
      ...deps.scheduler,
      log: deps.log,
    });
  }

  start(): void {
    this.sources.start();
    for (const run of this.runs.activeWithSession()) {
      // Triage runs follow report_triage, not the PM session they were sent to.
      if (this.definitions.find(run.automationId)?.action.type === "triage") continue;
      if (run.sessionId) this.sessionRuns.set(run.sessionId, run.id);
    }
    this.unsubscribe = this.deps.store.subscribe((events) => {
      setImmediate(() => this.onEvents(events));
    });
    this.scheduler.start();
  }

  stop(): void {
    this.unsubscribe?.();
    this.scheduler.stop();
    this.sources.stop();
  }

  // ---------------------------------------------------------------- state

  /** Global switch, project switch, the automation (or its per-project override), fit. */
  isEnabled(automation: Automation, project: Project): boolean {
    if (!this.deps.settings.get().automations.enabled || project.archivedAt) return false;
    if (!this.schedules.projectSettings(project.id).enabled) return false;
    if (automation.action.type === "triage" && project.kind !== "github") return false;
    if (automation.target.type === "project") return automation.enabled;
    const override = this.schedules.get(automation.id, project.id)?.enabledOverride;
    return override ?? automation.enabled;
  }

  /**
   * Whether scheduled and event automations fire on their own in this project. In Manual
   * mode (§10.1) they don't: only runs someone starts (the user or a PM) happen.
   */
  firesOnItsOwn(project: Project): boolean {
    return project.autonomyMode !== "manual";
  }

  /** Projects an automation applies to. */
  targets(automation: Automation): Project[] {
    if (automation.target.type === "project") {
      const id = automation.target.projectId;
      return this.deps.projects.list().filter((p) => p.id === id);
    }
    return this.deps.projects.list().filter((p) => !p.archivedAt);
  }

  /** Enabled, unpaused cron automations per project. */
  pairs(): SchedulePair[] {
    const out: SchedulePair[] = [];
    for (const automation of this.definitions.all()) {
      const trigger = automation.trigger;
      if (trigger.type !== "cron") continue;
      for (const project of this.targets(automation)) {
        if (!this.isEnabled(automation, project) || !this.firesOnItsOwn(project)) continue;
        if (this.schedules.get(automation.id, project.id)?.paused) continue;
        out.push({
          automation,
          project,
          expression: trigger.expression,
          timezone: effectiveTimezone(project, trigger.timezone),
        });
      }
    }
    return out;
  }

  list(projectId?: string): AutomationListResponse {
    if (projectId) this.deps.projects.get(projectId);
    const automations: AutomationListItem[] = [];
    for (const automation of this.definitions.all()) {
      const projects = this.targets(automation).filter((p) => !projectId || p.id === projectId);
      if (projectId && projects.length === 0) continue;
      automations.push({
        automation,
        states: projects.map((p) => this.state(automation, p)),
        lastRun: this.runs.latest(automation.id),
        path: this.sources.pathOf(automation.id),
        readOnly: automation.source !== "database",
      });
    }
    return { automations, errors: this.sources.fileErrors() };
  }

  state(automation: Automation, project: Project): AutomationState {
    const row = this.schedules.get(automation.id, project.id);
    const enabled = this.isEnabled(automation, project);
    const live =
      enabled && !row?.paused && automation.trigger.type === "cron" && this.firesOnItsOwn(project);
    return {
      projectId: project.id,
      enabled,
      enabledOverride: row?.enabledOverride ?? null,
      paused: row?.paused ?? false,
      nextRunAt: live ? (row?.nextRunAt ?? null) : null,
      skipNextAt: live ? (row?.skipAt ?? null) : null,
    };
  }

  /** Re-read files and recompute schedules (after definition or project changes). */
  refresh(): void {
    this.scheduler.refresh();
  }

  // ---------------------------------------------------------------- AutomationPort

  listScheduledRuns(projectId: string | null, limit = 10): ScheduledRun[] {
    return this.scheduler.upcoming(projectId, limit);
  }

  async skipNextRun(automationId: string, projectId: string): Promise<ScheduledRun | null> {
    this.inProject(automationId, projectId);
    if (!this.scheduler.skipNext(automationId, projectId)) return null;
    return (
      this.scheduler.upcoming(projectId, 100).find((r) => r.automationId === automationId) ?? null
    );
  }

  /** Undo `skipNextRun`; returns the next run (now not skipped), or null when none was skipped. */
  async unskipNextRun(automationId: string, projectId: string): Promise<ScheduledRun | null> {
    this.inProject(automationId, projectId);
    if (!this.scheduler.unskipNext(automationId, projectId)) return null;
    return (
      this.scheduler.upcoming(projectId, 100).find((r) => r.automationId === automationId) ?? null
    );
  }

  async pause(automationId: string, projectId: string): Promise<void> {
    this.inProject(automationId, projectId);
    this.schedules.upsert(automationId, projectId, { paused: true });
    this.scheduler.refresh();
  }

  async resume(automationId: string, projectId: string): Promise<void> {
    this.inProject(automationId, projectId);
    this.schedules.upsert(automationId, projectId, {
      paused: false,
      nextRunAt: null,
      skipAt: null,
    });
    this.scheduler.refresh();
  }

  async cancelQueuedRun(runId: string, projectId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run.projectId !== projectId)
      throw notFound(`No automation run ${runId}`, "automation_run_not_found");
    if (run.status !== "queued") throw conflict("Only queued runs can be cancelled", "not_queued");
    this.runs.save({ ...run, status: "cancelled", finishedAt: this.now().toISOString() });
    if (run.sessionId) {
      this.sessionRuns.delete(run.sessionId);
      await this.deps.sessions.stop(run.sessionId);
    }
  }

  /** Run now (`run_automation`, `POST /api/automations/:id/run`), with the conflict check. */
  async run(automationId: string, req: RunAutomationRequest): Promise<RunAutomationResponse> {
    const { automation, project } = this.inProject(automationId, req.projectId);
    const fire = this.fireRequest(automation, project, "manual", req.context);
    return this.fire({ ...fire, conflict: req.conflict });
  }

  // ---------------------------------------------------------------- internals

  private inProject(automationId: string, projectId: string) {
    const automation = this.definitions.get(automationId);
    const project = this.targets(automation).find((p) => p.id === projectId);
    if (!project) {
      throw notFound(
        `Automation ${automationId} does not run in that project`,
        "automation_not_found",
      );
    }
    return { automation, project };
  }

  private fireRequest(
    automation: Automation,
    project: Project,
    triggeredBy: FireRequest["triggeredBy"],
    extra: TemplateVars = {},
  ): FireRequest {
    const timezone = effectiveTimezone(
      project,
      automation.trigger.type === "cron" ? automation.trigger.timezone : undefined,
    );
    return {
      automation,
      project,
      triggeredBy,
      timezone,
      vars: { ...baseVars(project, this.now(), timezone), ...extra },
    };
  }

  /** Run, and track the session of a session run until it finishes. */
  private async fire(req: FireRequest): Promise<RunAutomationResponse> {
    const res = await this.executor.fire(req);
    const tracked = res.status === "started" || res.status === "queued";
    if (tracked && res.sessionId && req.automation.action.type === "start_session") {
      if (res.run.status === "queued" || res.run.status === "running") {
        this.sessionRuns.set(res.sessionId, res.run.id);
      }
    }
    return res;
  }

  /** The occurrence a PM skipped becomes a skipped run (it also notifies the PM). */
  private recordPmSkip(pair: SchedulePair): void {
    const req = this.fireRequest(pair.automation, pair.project, "cron");
    this.executor.recordSkipped(this.executor.newRun(req), "skipped_by_pm");
  }

  private triageAutomation(projectId: string): Automation | undefined {
    const project = this.deps.projects.list().find((p) => p.id === projectId);
    if (!project) return undefined;
    return this.definitions
      .all()
      .find(
        (a) =>
          a.action.type === "triage" &&
          this.targets(a).some((p) => p.id === projectId) &&
          this.isEnabled(a, project),
      );
  }

  private onEvents(events: RawEventEnvelope[]): void {
    try {
      if (events.some((e) => DEFINITION_EVENTS.has(e.type))) {
        // A new project gets the starter set, disabled (§10).
        for (const e of events) {
          if (e.type !== "project.created") continue;
          this.definitions.starterSet((e.payload as { project: Project }).project.id, false);
        }
        if (events.some((e) => e.type.startsWith("project."))) this.sources.reload();
        this.scheduler.refresh();
      }
      this.syncSessions(events);
      this.dispatch(events);
    } catch (error) {
      this.deps.log?.(`automations: ${errorMessage(error)}`);
    }
  }

  private syncSessions(events: RawEventEnvelope[]): void {
    const touched = new Set<string>();
    for (const e of events)
      if (e.sessionId && this.sessionRuns.has(e.sessionId)) touched.add(e.sessionId);
    for (const sessionId of touched) {
      const runId = this.sessionRuns.get(sessionId);
      const run = runId ? this.runs.find(runId) : undefined;
      const session = this.deps.repo.find(sessionId)?.session;
      if (!run || !session) {
        this.sessionRuns.delete(sessionId);
        continue;
      }
      const next = this.executor.syncFromSession(run, session) ?? run;
      if (next.status !== "queued" && next.status !== "running") this.sessionRuns.delete(sessionId);
    }
  }

  /** Fire event-triggered automations for matching events. */
  private dispatch(events: RawEventEnvelope[]): void {
    const session = (id: string) => this.deps.repo.find(id)?.session;
    const triggers = triggerEvents(events, session);
    if (triggers.length === 0) return;
    const all = this.definitions.all().filter((a) => a.trigger.type === "event");
    for (const event of triggers) {
      const project = this.deps.projects.list().find((p) => p.id === event.projectId);
      if (!project) continue;
      for (const automation of all) {
        if (!triggerMatches(automation, event)) continue;
        if (!this.targets(automation).some((p) => p.id === project.id)) continue;
        if (!this.isEnabled(automation, project) || !this.firesOnItsOwn(project)) continue;
        if (this.schedules.get(automation.id, project.id)?.paused) continue;
        if (startedByAutomation(automation, event, session)) continue;
        const req = this.fireRequest(automation, project, "event", event.vars);
        if (factoryOwnsIntake(automation, event, project)) {
          this.executor.recordSkipped(this.executor.newRun(req), "factory_intake");
          continue;
        }
        void this.fire({ ...req, issue: event.issue }).catch((error) =>
          this.deps.log?.(`automations: event run of ${automation.id}: ${errorMessage(error)}`),
        );
      }
    }
  }
}
