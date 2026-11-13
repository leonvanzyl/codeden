import { type EventEnvelope, type Project, type Snapshot, sortProjects } from "@codeden/contracts";
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
    case "session.updated":
      next.sessions = upsert(snap.sessions, env.payload.session);
      break;
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
    case "settings.updated":
      next.settings = env.payload.settings;
      break;
    default:
      break;
  }
  return next;
}
