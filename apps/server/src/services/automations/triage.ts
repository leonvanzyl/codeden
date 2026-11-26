import {
  type Automation,
  type AutomationRun,
  type AutonomyLevel,
  type GitHubIssueRef,
  type GithubIssue,
  type InboxItem,
  type Project,
  type StartedBy,
  StartSessionRequest,
  type StartSessionResponse,
  type TriageDecisionRequest,
  type TriageDecisionResponse,
  TriagePolicy,
  type TriageReport,
  type TriageReportResult,
  type WorkSummary,
} from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { githubIssues } from "../../db/schema";
import { badRequest, conflict } from "../errors";
import type { FactoryGithub } from "../factory/github-port";
import { hasWriteAccess, isTrustedAuthor, trustedLogins } from "../factory/trust";
import { rowToIssue } from "../github/rows";
import type { InboxService } from "../inbox-service";
import type { OrchestrationService } from "../orchestration/orchestration-service";
import type { ProjectService } from "../projects/project-service";
import type { SessionService } from "../sessions/session-service";
import { issueSessionPrompt, triageRequestText } from "./triage-prompts";

/** What triage asks GitHub to decide whether an issue's author is trusted. */
export type TriageGithub = Pick<FactoryGithub, "viewerLogin" | "issueAuthor">;

/** Whether an issue's author may have work started for them without asking. */
export interface AuthorTrust {
  trusted: boolean;
  author: string | null;
  /** GitHub answered the write-access question (false: it could not be checked). */
  checked: boolean;
}

export interface TriageDeps {
  db: Db;
  inbox: InboxService;
  sessions: SessionService;
  projects: ProjectService;
  orchestration: () => OrchestrationService;
  /** Who opened an issue and whether they have write access (shared with the factory). */
  github: TriageGithub;
  /** The project's enabled triage automation, if any. */
  triageAutomation: (projectId: string) => Automation | undefined;
  /**
   * The permission level of a session it starts: its policy's, capped at the level a person
   * approved (undefined: the project's default). The policy's own level when absent.
   */
  sessionAutonomy?: (automation: Automation, project: Project) => AutonomyLevel | undefined;
  /** Running or queued work in a project (sessions and automation runs). */
  activeWork: (projectId: string) => WorkSummary[];
  /** A report arrived: complete the triage runs waiting on this issue. */
  reported?: (projectId: string, issueNumber: number, decision: string) => void;
}

/** Inbox id of the "Should I take this on?" decision for an issue. */
export function triageItemId(projectId: string, issueNumber: number): string {
  return `triage:${projectId}:${issueNumber}`;
}

function policyOf(automation: Automation | undefined): TriagePolicy {
  const raw = automation?.action.type === "triage" ? automation.action.policy : undefined;
  return TriagePolicy.parse(raw ?? {});
}

/** How a triage decision settles when the issue's work is already running. */
function alreadyRunning(running: WorkSummary[]): { by: "codeden"; note: string } {
  const what = running[0]?.purpose ?? "another session";
  return { by: "codeden", note: `Already being worked on: ${what}` };
}

/** What the inbox item says when the author is not trusted. */
function untrustedNote({ author, checked }: AuthorTrust): string {
  const who = author ? `@${author}` : "an unknown author";
  return checked
    ? `Opened by ${who}, who has no write access to the repository and is not a trusted author, so CodeDen won't start work on it without you.`
    : `Opened by ${who}, who is not a trusted author. CodeDen couldn't check their write access on GitHub, so it won't start work on it without you.`;
}

/**
 * Issue triage (§10). A triage run hands the new issue to the project's PM with the policy;
 * the PM classifies it with its GitHub tools (`get_issue`, `list_issues`, `triage_issue`) and
 * calls `report_triage`. A `ready` issue then starts a session when the policy allows it, the
 * project is not in manual mode and its author is trusted; otherwise it becomes an inbox
 * decision that the user accepts (a session starts) or declines.
 *
 * On a public repository anyone can open an issue, and an issue is a prompt for an agent. So
 * only issues by trusted authors start work by themselves: the factory's trusted authors, the
 * account CodeDen uses on GitHub, and people with write access to the repository.
 */
export class TriageService {
  constructor(private readonly deps: TriageDeps) {}

  /** Send the triage request to the PM; returns the PM session id. */
  async request(
    project: Project,
    automation: Automation,
    run: AutomationRun,
    issue: GithubIssue | GitHubIssueRef,
  ): Promise<string> {
    if (project.kind !== "github") throw badRequest("Triage needs a GitHub project", "not_github");
    const policy = policyOf(automation);
    const canStart = policy.autoStart && project.autonomyMode !== "manual";
    const text = triageRequestText({ automation, run, issue, policy, canStart });
    const res = await this.deps
      .orchestration()
      .sendToRole("pm", project.id, { text, attachments: [] }, "queue", "automation");
    return res.sessionId;
  }

  /** The PM's `report_triage`. */
  async report(project: Project, report: TriageReport): Promise<TriageReportResult> {
    try {
      return await this.act(project, report);
    } finally {
      this.deps.reported?.(project.id, report.issueNumber, report.decision);
    }
  }

  private async act(project: Project, report: TriageReport): Promise<TriageReportResult> {
    if (report.decision !== "ready") return { status: "recorded" };
    const id = triageItemId(project.id, report.issueNumber);
    const running = this.issueWork(project.id, report.issueNumber);
    if (running.length > 0) {
      // Someone already took it on: asking "Should I take this on?" would only lead to a conflict.
      const open = this.deps.inbox.find(id);
      if (open?.status === "open") this.deps.inbox.settle(open, alreadyRunning(running));
      return { status: "already_running", existing: running };
    }
    const automation = this.deps.triageAutomation(project.id);
    const policy = this.sessionPolicy(automation, project);
    const { issue, author } = this.syncedIssue(project, report.issueNumber);
    const trust = await this.authorTrust(project, report.issueNumber, author);
    if (automation && policy.autoStart && project.autonomyMode !== "manual" && trust.trusted) {
      const start = await this.startForIssue(project, issue, report.summary, policy, {
        kind: "automation",
        id: automation.id,
      });
      return { status: "started", start };
    }
    const existing = this.deps.inbox.find(id);
    if (existing?.status === "open") return { status: "inbox", inboxItemId: id };
    const now = new Date().toISOString();
    const item: InboxItem = {
      id,
      kind: "triage",
      status: "open",
      priority: "normal",
      notify: "automation",
      title: `Should I take this on? #${issue.number} ${issue.title ?? ""}`.trim(),
      body: trust.trusted
        ? report.summary
        : [report.summary, untrustedNote(trust)].filter((s) => s !== "").join("\n\n"),
      projectId: project.id,
      sessionId: null,
      threadId: null,
      itemId: null,
      requestId: null,
      issue,
      pr: null,
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
    this.deps.inbox.put(item);
    return { status: "inbox", inboxItemId: id };
  }

  /** Accept a triage decision: start a session for the issue and close the item. */
  async accept(itemId: string, req: TriageDecisionRequest): Promise<TriageDecisionResponse> {
    const item = this.openItem(itemId);
    const project = this.deps.projects.get(item.projectId ?? "");
    if (!item.issue) throw badRequest("The decision has no issue", "no_issue");
    const running = req.conflict ? [] : this.issueWork(project.id, item.issue.number);
    if (running.length > 0) {
      // The work started since the PM asked (the factory or another session picked it up):
      // there is nothing left to decide, so the decision closes instead of raising a conflict.
      const closed = this.deps.inbox.settle(item, alreadyRunning(running));
      return { item: closed, start: { status: "conflict", existing: running } };
    }
    const policy = this.sessionPolicy(this.deps.triageAutomation(project.id), project);
    const start = await this.startForIssue(
      project,
      item.issue,
      item.body ?? "",
      { ...policy, provider: req.provider ?? policy.provider, model: req.model ?? policy.model },
      { kind: "user" },
      req.conflict,
    );
    if (start.status === "conflict") return { item, start };
    const closed = this.deps.inbox.close(item, "resolved", {
      decision: "accept",
      start: JSON.parse(JSON.stringify(start)),
    });
    return { item: closed, start };
  }

  /** Decline: close the item; the issue keeps its triage labels. */
  decline(itemId: string, req: TriageDecisionRequest): TriageDecisionResponse {
    const item = this.openItem(itemId);
    const closed = this.deps.inbox.close(item, "dismissed", {
      decision: "decline",
      ...(req.reason ? { reason: req.reason } : {}),
    });
    return { item: closed, start: null };
  }

  /** The policy for the sessions it starts, at no more than the approved permission level. */
  private sessionPolicy(automation: Automation | undefined, project: Project): TriagePolicy {
    const policy = policyOf(automation);
    if (!automation || !this.deps.sessionAutonomy) return policy;
    return { ...policy, autonomy: this.deps.sessionAutonomy(automation, project) };
  }

  /** Running or queued work on issue `number` (its work key is `issue:<number>`). */
  private issueWork(projectId: string, number: number): WorkSummary[] {
    return this.deps.activeWork(projectId).filter((w) => w.workKey === `issue:${number}`);
  }

  private openItem(itemId: string): InboxItem {
    const item = this.deps.inbox.get(itemId);
    if (item.kind !== "triage") throw badRequest("Not a triage decision", "not_triage");
    if (item.status !== "open") throw conflict("The decision was already made", "resolved");
    return item;
  }

  private async startForIssue(
    project: Project,
    issue: GitHubIssueRef,
    summary: string,
    policy: TriagePolicy,
    startedBy: StartedBy,
    decision?: TriageDecisionRequest["conflict"],
  ): Promise<StartSessionResponse> {
    const title = issue.title ?? `Issue #${issue.number}`;
    const prompt = issueSessionPrompt(issue, summary);
    return this.deps.sessions.start(
      StartSessionRequest.parse({
        projectId: project.id,
        role: "agent",
        provider: policy.provider,
        model: policy.model,
        autonomy: policy.autonomy,
        purpose: `Resolve #${issue.number}: ${title}`.slice(0, 300),
        workKey: `issue:${issue.number}`,
        startedBy,
        title: `#${issue.number} ${title}`.slice(0, 200),
        issue,
        // The triage automation wrote the brief, whoever accepted it.
        input: { text: prompt, attachments: [], from: "automation" },
        conflict: decision,
      }),
    );
  }

  /**
   * Whether the author of issue `number` is trusted, by the rule triage uses. The PM's
   * `start_session` checks it in turns the user's own message didn't start (#137).
   */
  async issueAuthorTrust(project: Project, number: number): Promise<AuthorTrust> {
    const { author } = this.syncedIssue(project, number);
    return this.authorTrust(project, number, author);
  }

  /**
   * Whether the issue's author is trusted: a trusted author of the project, the account
   * CodeDen uses on GitHub, or someone with write access to the repository. Unknown authors,
   * and authors whose access GitHub can't confirm right now, are not.
   */
  private async authorTrust(
    project: Project,
    number: number,
    synced: string | null,
  ): Promise<AuthorTrust> {
    const viewer = await this.deps.github.viewerLogin().catch(() => null);
    const logins = trustedLogins(project.factoryLimits, viewer);
    if (isTrustedAuthor(synced, logins)) return { trusted: true, author: synced, checked: true };
    const live = await this.deps.github.issueAuthor(project.id, number).catch(() => null);
    const author = live?.login ?? synced;
    if (!live) return { trusted: false, author, checked: false };
    const trusted = isTrustedAuthor(author, logins) || hasWriteAccess(live.association);
    return { trusted, author, checked: true };
  }

  /** The synced issue and its author when known, else a link built from the repository. */
  private syncedIssue(
    project: Project,
    number: number,
  ): { issue: GitHubIssueRef; author: string | null } {
    const row = this.deps.db
      .select()
      .from(githubIssues)
      .where(and(eq(githubIssues.projectId, project.id), eq(githubIssues.number, number)))
      .get();
    if (row) {
      const issue = rowToIssue(row);
      return { issue: { number, url: issue.url, title: issue.title }, author: issue.author };
    }
    if (project.kind !== "github") throw badRequest("Triage needs a GitHub project", "not_github");
    const url = `https://github.com/${project.github.owner}/${project.github.repo}/issues/${number}`;
    return { issue: { number, url }, author: null };
  }
}
