import {
  type EventEnvelope,
  type Project,
  type ProjectGroup,
  type Session,
  type Snapshot,
  sortProjects,
} from "@codeden/contracts";
import { withOrder } from "./project-order";

function upsert<T extends { id: string }>(list: T[], next: T): T[] {
  const i = list.findIndex((x) => x.id === next.id);
  if (i === -1) return [...list, next];
  const copy = [...list];
  copy[i] = next;
  return copy;
}

/** The snapshot lists active projects only, in the canonical order (§13). */
function upsertProject(list: Project[], project: Project): Project[] {
  if (project.archivedAt !== null) return list.filter((p) => p.id !== project.id);
  return sortProjects(upsert(list, project));
}

/** Groups are listed by name, then id (like `GET /api/groups`). */
function upsertGroup(list: ProjectGroup[], group: ProjectGroup): ProjectGroup[] {
  return upsert(list, group).sort(
    (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Move a project's archived agent session count by `delta`; projects at zero are left out. */
function shiftArchivedCount(
  counts: Record<string, number>,
  session: Session,
  delta: number,
): Record<string, number> {
  if (delta === 0 || session.role !== "agent" || !session.projectId) return counts;
  const { [session.projectId]: current = 0, ...rest } = counts;
  const next = Math.max(0, current + delta);
  return next > 0 ? { ...rest, [session.projectId]: next } : rest;
}

/**
 * Apply a session event. The snapshot holds every session that isn't archived plus the recently
 * archived ones, so an update for a session it doesn't have is for one archived before that:
 * it stays out (nothing is copied) unless it was unarchived. The archived counts follow.
 */
function applySession(
  snap: Snapshot,
  session: Session,
  created: boolean,
): Pick<Snapshot, "sessions" | "archivedSessionCounts"> {
  const prev = snap.sessions.find((s) => s.id === session.id);
  if (!prev && !created && session.archivedAt) {
    return { sessions: snap.sessions, archivedSessionCounts: snap.archivedSessionCounts };
  }
  const wasArchived = prev ? Boolean(prev.archivedAt) : !created;
  const delta = Number(Boolean(session.archivedAt)) - Number(wasArchived);
  return {
    sessions: upsert(snap.sessions, session),
    archivedSessionCounts: shiftArchivedCount(snap.archivedSessionCounts, session, delta),
  };
}

/**
 * Add a project the UI just created, unless its `project.created` event got there first (that
 * copy is the server's latest). The event still applies when it arrives: the seq is unchanged.
 */
export function withCreatedProject(snap: Snapshot, project: Project): Snapshot {
  if (snap.projects.some((p) => p.id === project.id)) return snap;
  return { ...snap, projects: upsertProject(snap.projects, project) };
}

/**
 * Apply a domain event (project/session/inbox/automation/settings) to the app snapshot.
 * Agent events are ignored here; they go to the transcript store.
 */
export function applyDomainEvent(snap: Snapshot, env: EventEnvelope): Snapshot {
  if (env.seq <= snap.seq) return snap;
  const next: Snapshot = { ...snap, seq: env.seq };
  switch (env.type) {
    case "project.created":
    case "project.updated":
      next.projects = upsertProject(snap.projects, env.payload.project);
      break;
    case "project.archived":
      next.projects = snap.projects.filter((p) => p.id !== env.payload.projectId);
      break;
    case "projects.reordered":
      next.projects = withOrder(snap.projects, env.payload.projectIds);
      break;
    case "session.created":
    case "session.updated": {
      const applied = applySession(snap, env.payload.session, env.type === "session.created");
      next.sessions = applied.sessions;
      next.archivedSessionCounts = applied.archivedSessionCounts;
      break;
    }
    case "inbox.created":
    case "inbox.updated":
      next.inbox = upsert(snap.inbox, env.payload.item);
      break;
    case "automation.saved":
      next.automations = upsert(snap.automations, env.payload.automation);
      break;
    case "automation.deleted":
      next.automations = snap.automations.filter((a) => a.id !== env.payload.automationId);
      break;
    case "project_group.saved":
      next.groups = upsertGroup(snap.groups, env.payload.group);
      break;
    case "project_group.deleted":
      next.groups = snap.groups.filter((g) => g.id !== env.payload.groupId);
      break;
    case "settings.updated":
      next.settings = env.payload.settings;
      break;
    default:
      break;
  }
  return next;
}
