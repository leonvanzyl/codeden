import type { Session } from "@codeden/contracts";

/** Whether the page at `pathname` belongs to the project: one of its pages or sessions. */
export function showsProject(pathname: string, projectId: string, sessions: Session[]): boolean {
  if (pathname === `/projects/${projectId}` || pathname.startsWith(`/projects/${projectId}/`)) {
    return true;
  }
  return sessions.some((s) => pathname === `/sessions/${s.id}`);
}
