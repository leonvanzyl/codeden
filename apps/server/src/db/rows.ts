import {
  Artifact,
  Automation,
  type AutomationRun,
  InboxItem,
  type ItemRecord,
  Project,
  Session,
  type Thread,
  type Turn,
} from "@codeden/contracts";
import type { TurnRecord } from "../events/reducer/types";
import type {
  artifacts,
  automationRuns,
  automations,
  inboxItems,
  items,
  projects,
  sessions,
  threads,
  turns,
} from "./schema";

/** Mapping between contract entities and projection rows. Rows are validated on the way out. */

type ProjectRow = typeof projects.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type InboxRow = typeof inboxItems.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;
type AutomationRow = typeof automations.$inferSelect;

export function projectToRow(p: Project): ProjectRow {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    slug: p.slug,
    path: p.path,
    defaultBranch: p.defaultBranch,
    defaultProvider: p.defaultProvider,
    defaultModel: p.defaultModel,
    defaultEffort: p.defaultEffort,
    autonomy: p.autonomy,
    autonomyMode: p.autonomyMode,
    visionPath: p.visionPath,
    factoryLimits: p.factoryLimits,
    killSwitch: p.killSwitch,
    timezone: p.timezone,
    agentCiEnv: p.agentCiEnv,
    pinned: p.pinned,
    sortOrder: p.sortOrder,
    github: p.kind === "github" ? p.github : null,
    remoteWarning: p.remoteWarning ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
  };
}

export function rowToProject(r: ProjectRow): Project {
  const { github, factoryLimits, remoteWarning, ...rest } = r;
  return Project.parse({
    ...rest,
    factoryLimits: factoryLimits ?? undefined,
    ...(r.kind === "github" ? { github } : {}),
    ...(remoteWarning ? { remoteWarning } : {}),
  });
}

/** Session columns only; `usage` and `startMeta` are written separately. */
export function sessionToRow(s: Session): Omit<SessionRow, "usage" | "startMeta"> {
  return {
    ...s,
    planMode: s.planMode ?? false,
    result: s.result ?? null,
    archivedAt: s.archivedAt ?? null,
    worktreeRemovedAt: s.worktreeRemovedAt ?? null,
    forkedFrom: s.forkedFrom ?? null,
    startError: s.startError ?? null,
  };
}

export function rowToSession(r: SessionRow): Session {
  return Session.parse(r);
}

export function inboxToRow(i: InboxItem): InboxRow {
  return { ...i };
}

export function rowToInbox(r: InboxRow): InboxItem {
  return InboxItem.parse(r);
}

export function automationToRow(a: Automation): AutomationRow {
  return { ...a, workKey: a.workKey ?? null, createdBy: a.createdBy ?? null };
}

export function rowToAutomation(r: AutomationRow): Automation {
  const { workKey, createdBy, ...rest } = r;
  return Automation.parse({
    ...rest,
    ...(workKey === null ? {} : { workKey }),
    ...(createdBy === null ? {} : { createdBy }),
  });
}

export function runToRow(run: AutomationRun): RunRow {
  return { ...run, issueNumber: run.issueNumber ?? null };
}

export function rowToThread(r: typeof threads.$inferSelect): Thread {
  return r;
}

export function rowToTurn(r: typeof turns.$inferSelect): Turn {
  const { usage: _usage, ...turn } = r;
  return { ...turn, status: r.status as Turn["status"] };
}

export function rowToTurnRecord(r: typeof turns.$inferSelect): TurnRecord {
  return { ...r, status: r.status as Turn["status"] };
}

export function rowToItemRecord(r: typeof items.$inferSelect): ItemRecord {
  return {
    sessionId: r.sessionId,
    threadId: r.threadId,
    turnId: r.turnId,
    position: r.position,
    item: r.data,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function rowToArtifact(r: typeof artifacts.$inferSelect): Artifact {
  return Artifact.parse(r);
}
