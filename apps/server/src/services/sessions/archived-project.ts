import type { Session } from "@codeden/contracts";
import { badRequest } from "../errors";
import type { ProjectService } from "../projects/project-service";

/**
 * Archiving a project makes its sessions read-only (§13): their transcripts stay, but no new
 * input reaches them, whoever sends it (the user, the PM or orchestrator, an automation, the
 * factory, a notice or a wake-up). Adding the project's folder again restores it.
 */

/** Whether the session belongs to an archived project. */
export function inArchivedProject(
  projects: Pick<ProjectService, "get">,
  session: Pick<Session, "projectId">,
): boolean {
  if (!session.projectId) return false;
  try {
    return projects.get(session.projectId).archivedAt !== null;
  } catch {
    return false; // No such project: nothing to refuse for.
  }
}

/** Refuse new input to a session of an archived project. */
export function assertProjectActive(
  projects: Pick<ProjectService, "get">,
  session: Pick<Session, "projectId">,
): void {
  if (inArchivedProject(projects, session)) {
    throw badRequest(
      "This project is archived, so its sessions are read-only. Add its folder again to restore it.",
      "project_archived",
    );
  }
}
