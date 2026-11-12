import { randomUUID } from "node:crypto";
import {
  type Automation,
  type AutomationRun,
  type ConflictDecision,
  type GitHubIssueRef,
  type GithubIssue,
  type Project,
  type RunAutomationResponse,
  type Session,
  type SessionStatus,
  StartSessionRequest,
  type TurnStatus,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { OrchestrationService } from "../orchestration/orchestration-service";
import { findConflicts } from "../sessions/conflicts";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import {
  overConcurrencyCap,
  overlapOutcome,
  preflightSkip,
  type SkipReason,
  type TriggerKind,
} from "./guards";
import { renderTemplate, renderWorkKey, runHeader, type TemplateVars } from "./prompt";
import type { RunStore } from "./runs";
import type { TriageService } from "./triage";

export interface ExecutorDeps {
  runs: RunStore;
  sessions: SessionService;
  repo: SessionRepo;
  orchestration: () => OrchestrationService;
  triage: TriageService;
  /** Status of the session's latest root-thread turn. */
  lastTurnStatus: (session: Session) => TurnStatus | null;
  now: () => Date;
  log?: (message: string) => void;
}

/** One attempt to run an automation in a project. */
export interface FireRequest {
  automation: Automation;
  project: Project;
  triggeredBy: TriggerKind;
  timezone: string;
  vars: TemplateVars;
  /** The issue a triage or issue-event run is about. */
  issue?: GithubIssue | GitHubIssueRef;
  /** Manual runs: the caller's decision after a `conflict`. */
  conflict?: ConflictDecision;
}

const TRIGGER_TEXT: Record<TriggerKind, string> = {
  cron: "scheduled",
  catch_up: "catching up a missed schedule",
  event: "event trigger",
  manual: "run by hand",
};

/**
 * The run status a tracked session's status maps to. An idle session finished its turn: the
 * run completed, unless that turn was interrupted (stopped) or failed.
 */
export function runStatusForSession(
  status: SessionStatus,
  lastTurn: TurnStatus | null = "completed",
): AutomationRun["status"] {
  switch (status) {
    case "created":
    case "queued":
      return "queued";
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "idle":
    case "completed":
      return lastTurn === "interrupted"
        ? "cancelled"
        : lastTurn === "failed"
          ? "failed"
          : "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "interrupted":
      return "cancelled";
  }
}

/** How long a triage run waits for the PM's `report_triage` before it counts as failed. */
export const TRIAGE_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs an automation once (§10): applies quiet hours and the daily cap, the §8.4 overlap policy
 * through the work-key conflict check, and the concurrency cap, then performs the action. Every
 * outcome except a manual `conflict` is an `automation_run` row; skipped rows carry the reason
 * and wake the PM through the `automation.skipped` notice.
 */
export class AutomationExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  /** A new run for `req`, not yet saved. */
  newRun(req: FireRequest, now: Date = this.deps.now()): AutomationRun {
    const { automation, project } = req;
    return {
      id: randomUUID(),
      automationId: automation.id,
      projectId: project.id,
      status: "running",
      triggeredBy: req.triggeredBy,
      startedBy: { kind: "automation", id: automation.id },
      purpose: `${automation.name}${req.issue ? ` #${req.issue.number}` : ""}`,
      workKey: renderWorkKey(automation, req.vars),
      scope: { projectId: project.id },
      progress: null,
      skipReason: null,
      sessionId: null,
      issueNumber: req.issue?.number ?? null,
      startedAt: now.toISOString(),
      finishedAt: null,
      error: null,
    };
  }

  /** Record a run skipped before it started (also used for occurrences a PM skipped). */
  recordSkipped(run: AutomationRun, reason: SkipReason): AutomationRun {
    return this.deps.runs.save({
      ...run,
      status: "skipped",
      skipReason: reason,
      finishedAt: run.startedAt,
    });
  }

  /**
   * Fail triage runs whose PM never reported (so they stop counting against the concurrency
   * cap and the overlap check).
   */
  expireStaleTriage(automationId: string, projectId: string, now: Date): void {
    const before = new Date(now.getTime() - TRIAGE_TIMEOUT_MS).toISOString();
    for (const run of this.deps.runs.runningBefore(automationId, projectId, before)) {
      this.deps.runs.save({
        ...run,
        status: "failed",
        finishedAt: now.toISOString(),
        error: { message: "The PM did not report a triage decision within 30 minutes" },
      });
    }
  }

  /** Complete the running triage runs for an issue once the PM's `report_triage` arrives. */
  completeTriage(projectId: string, issueNumber: number, decision: string): AutomationRun[] {
    const now = this.deps.now().toISOString();
    return this.deps.runs.runningForIssue(projectId, issueNumber).map((run) =>
      this.deps.runs.save({
        ...run,
        status: "completed",
        finishedAt: now,
        progress: { text: `Triaged as ${decision}`, at: now },
      }),
    );
  }

  async fire(req: FireRequest): Promise<RunAutomationResponse> {
    const { automation, project, triggeredBy } = req;
    const now = this.deps.now();
    if (automation.action.type === "triage") this.expireStaleTriage(automation.id, project.id, now);
    const run = this.newRun(req, now);
    const workKey = run.workKey;
    const skip = (reason: SkipReason): RunAutomationResponse => ({
      status: "skipped",
      run: this.recordSkipped(run, reason),
    });

    const pre = preflightSkip({
      guards: automation.guards,
      triggeredBy,
      now,
      timezone: req.timezone,
      runsToday: this.deps.runs.countToday(automation.id, project.id, now, req.timezone),
    });
    if (pre) return skip(pre);

    const conflicts = findConflicts(
      { workKey, scope: run.scope },
      this.deps.repo.activeWork(project.id),
    );
    const overlap = overlapOutcome(automation.guards, triggeredBy, conflicts, req.conflict);
    if (overlap.kind === "conflict") return { status: "conflict", existing: overlap.existing };
    if (overlap.kind === "skip") return skip(overlap.reason);
    const decision = overlap.kind === "decide" ? overlap.decision : undefined;
    const active = this.deps.runs.activeCount(automation.id, project.id);
    if (
      overConcurrencyCap(automation.guards, triggeredBy, active, decision?.resolution === "wait")
    ) {
      return skip("concurrency");
    }

    try {
      switch (automation.action.type) {
        case "start_session":
          return await this.startSession(req, run, decision);
        case "message_pm": {
          const text = renderTemplate(automation.action.message, req.vars);
          const res = await this.deps.orchestration().sendToRole(
            "pm",
            project.id,
            {
              text: `Automation "${automation.name}" (${TRIGGER_TEXT[triggeredBy]}):\n\n${text}`,
              attachments: [],
            },
            "queue",
            "automation",
          );
          return this.finished(run, res.sessionId);
        }
        case "triage": {
          if (!req.issue) throw new Error("Triage runs need an issue (trigger it on issue.opened)");
          const pmId = await this.deps.triage.request(project, automation, run, req.issue);
          // Done when the PM's report_triage for this issue arrives, not when it got the request.
          const waiting = this.deps.runs.save({
            ...run,
            sessionId: pmId,
            progress: { text: "Waiting for the PM's triage decision", at: now.toISOString() },
          });
          return { status: "started", run: waiting, sessionId: pmId };
        }
      }
    } catch (error) {
      this.deps.log?.(`automations: run of ${automation.id} failed: ${errorMessage(error)}`);
      const failed = this.deps.runs.save({
        ...run,
        status: "failed",
        finishedAt: this.deps.now().toISOString(),
        error: { message: errorMessage(error) },
      });
      return { status: "started", run: failed, sessionId: null };
    }
  }

  /** Keep a run in step with the session it started. */
  syncFromSession(run: AutomationRun, session: Session): AutomationRun | null {
    if (run.status !== "queued" && run.status !== "running") return null;
    const status = runStatusForSession(session.status, this.deps.lastTurnStatus(session));
    if (!status || status === run.status) return null;
    const terminal = status !== "queued" && status !== "running";
    return this.deps.runs.save({
      ...run,
      status,
      progress: session.progress,
      finishedAt: terminal ? this.deps.now().toISOString() : null,
      error:
        status === "failed"
          ? { message: session.result?.summary ?? "The session failed" }
          : run.error,
    });
  }

  private finished(run: AutomationRun, sessionId: string): RunAutomationResponse {
    const saved = this.deps.runs.save({
      ...run,
      status: "completed",
      sessionId,
      finishedAt: this.deps.now().toISOString(),
    });
    return { status: "started", run: saved, sessionId };
  }

  private async startSession(
    req: FireRequest,
    run: AutomationRun,
    decision: ConflictDecision | undefined,
  ): Promise<RunAutomationResponse> {
    const { automation, project } = req;
    if (automation.action.type !== "start_session") throw new Error("not a session action");
    const action = automation.action;
    const prompt = renderTemplate(action.prompt, req.vars);
    const start = StartSessionRequest.parse({
      projectId: project.id,
      role: "agent",
      provider: action.provider,
      model: action.model,
      effort: action.effort,
      autonomy: action.autonomy,
      purpose: run.purpose,
      workKey: run.workKey,
      startedBy: run.startedBy,
      title: action.title ? renderTemplate(action.title, req.vars) : automation.name,
      issue: req.issue
        ? { number: req.issue.number, url: req.issue.url, title: req.issue.title }
        : undefined,
      input: {
        text: `${runHeader(automation, run.id, TRIGGER_TEXT[req.triggeredBy])}\n\n${prompt}`,
        attachments: [],
        from: "automation",
      },
      conflict: decision,
    });
    const res = await this.deps.sessions.start(start);
    switch (res.status) {
      case "conflict":
        if (req.triggeredBy === "manual" && !decision) {
          return { status: "conflict", existing: res.existing };
        }
        return { status: "skipped", run: this.recordSkipped(run, "overlap") };
      case "skipped":
        return { status: "skipped", run: this.recordSkipped(run, "conflict_skip") };
      case "joined":
        this.deps.runs.save({
          ...run,
          status: "completed",
          sessionId: res.sessionId,
          finishedAt: run.startedAt,
        });
        return { status: "joined", sessionId: res.sessionId };
      case "queued":
      case "started": {
        const saved = this.deps.runs.save({
          ...run,
          status: res.status === "queued" ? "queued" : "running",
          sessionId: res.sessionId,
        });
        const session = this.deps.repo.update(res.sessionId, (s) => ({
          ...s,
          automationRunId: saved.id,
        }));
        const synced = this.syncFromSession(saved, session) ?? saved;
        return res.status === "queued"
          ? { status: "queued", run: synced, sessionId: res.sessionId, behind: res.behind }
          : { status: "started", run: synced, sessionId: res.sessionId };
      }
    }
  }
}
