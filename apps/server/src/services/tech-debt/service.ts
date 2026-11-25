import {
  type Project,
  TERMINAL_SESSION_STATUSES,
  TechDebtAction,
  type TechDebtActionResult,
  type TechDebtFinding,
  type TechDebtList,
  type TechDebtView,
} from "@codeden/contracts";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectTechDebt, sessions } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, errorMessage, notFound } from "../errors";
import { debtId, issueFindings, syncDebtTick, type TechDebtIssuePort } from "./issue";

type StartFix = (project: Project, findings: TechDebtFinding[]) => Promise<string>;

export class TechDebtService {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly issues: TechDebtIssuePort,
    private readonly startFix: StartFix,
  ) {}

  list(project: Project): Promise<TechDebtList> {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      if (!view.issue || view.imported) return view;
      let issue: Awaited<ReturnType<TechDebtIssuePort["read"]>>;
      try {
        issue = await this.issues.read(view.issue);
      } catch (error) {
        return { ...view, importError: errorMessage(error) };
      }
      const findings = new Map(view.findings.map((finding) => [finding.id, finding]));
      for (const finding of issueFindings(view.issue, issue.body, issue.date)) {
        if (!findings.has(finding.id)) findings.set(finding.id, finding);
      }
      return this.save({ ...view, imported: true, findings: [...findings.values()] });
    });
  }

  act(project: Project, input: TechDebtAction): Promise<TechDebtActionResult> {
    return this.inProject(project, async () => {
      const action = TechDebtAction.parse(input);
      const view = this.get(project.id);
      switch (action.action) {
        case "configure":
          return action.issue === view.issue && !view.imported
            ? view
            : this.save({ ...view, issue: action.issue, imported: false });
        case "record": {
          const id = debtId(JSON.stringify(action.finding));
          if (view.findings.some((finding) => finding.id === id)) return view;
          const finding: TechDebtFinding = {
            ...action.finding,
            id,
            source: null,
            status: "open",
            sessionId: null,
            reason: null,
          };
          return this.save({ ...view, findings: [...view.findings, finding] });
        }
        case "fix": {
          const selected = action.ids.map((id) => this.find(view, id));
          if (selected.some((finding) => finding.status !== "open")) {
            throw badRequest("Select open findings or wait for their current fix sessions to end");
          }
          const sessionId = await this.startFix(project, selected);
          const ids = new Set(action.ids);
          return this.save({
            ...view,
            findings: view.findings.map((finding) =>
              ids.has(finding.id) ? { ...finding, sessionId, status: "in_progress" } : finding,
            ),
          });
        }
        case "fixed":
        case "dismiss": {
          const finding = this.find(view, action.id);
          const status = action.action === "fixed" ? "fixed" : "dismissed";
          const reason = action.action === "dismiss" ? action.reason : null;
          if (finding.status === status && finding.reason === reason) return view;
          if (finding.status === "fixed" || finding.status === "dismissed") {
            throw badRequest("This finding is already closed");
          }
          const closed = this.save({
            ...view,
            findings: view.findings.map((row) =>
              row.id === finding.id ? { ...row, status, reason } : row,
            ),
          });
          const issue = view.issue;
          if (issue && (!finding.source || finding.source.toLowerCase() === issue.toLowerCase())) {
            try {
              await this.serial(`issue:${issue.toLowerCase()}`, () =>
                syncDebtTick(this.issues, issue, finding),
              );
            } catch {
              return { ...closed, syncError: "Finding closed locally. Could not sync the issue." };
            }
          }
          return closed;
        }
      }
    });
  }

  private get(projectId: string): TechDebtView {
    const view = this.db
      .select()
      .from(projectTechDebt)
      .where(eq(projectTechDebt.projectId, projectId))
      .get()?.view ?? { projectId, issue: null, imported: false, findings: [] };
    const fixing = view.findings.filter((finding) => finding.status === "in_progress");
    if (!fixing.length) return view;
    const ids = [...new Set(fixing.flatMap(({ sessionId }) => (sessionId ? [sessionId] : [])))];
    const rows = ids.length
      ? this.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, projectId),
              inArray(sessions.id, ids),
              notInArray(sessions.status, [...TERMINAL_SESSION_STATUSES]),
            ),
          )
          .all()
      : [];
    const unfinished = new Set(rows.map(({ id }) => id));
    return {
      ...view,
      findings: view.findings.map((finding) =>
        finding.status === "in_progress" && !unfinished.has(finding.sessionId ?? "")
          ? { ...finding, status: "open", sessionId: null }
          : finding,
      ),
    };
  }

  private save(view: TechDebtView): TechDebtView {
    this.store.append([{ type: "tech_debt.updated", sessionId: null, payload: { view } }]);
    return view;
  }

  private find(view: TechDebtView, id: string): TechDebtFinding {
    const finding = view.findings.find((row) => row.id === id);
    if (!finding) throw notFound("Tech debt finding not found");
    return finding;
  }

  private async inProject<T>(project: Project, operation: () => Promise<T>): Promise<T> {
    if (project.archivedAt) throw badRequest("Project is archived");
    return this.serial(`project:${project.id}`, operation);
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(key) ?? Promise.resolve()).then(operation, operation);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }
}
