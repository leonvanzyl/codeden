import type { AutonomyLevel, Session, SessionStatus } from "@codeden/contracts";

/** Statuses a session doesn't leave by itself: it has finished, failed or was stopped. */
const ENDED: readonly SessionStatus[] = ["completed", "failed", "stopped"];

/**
 * The project's open agent sessions whose permission level differs from `level`, the one its new
 * sessions start with (§11.2). A session's level is its own from the moment it is created:
 * changing the project's default (or the one in Settings) never reaches a session that exists,
 * so the project's settings name the ones that keep another level. Archived and ended sessions
 * are left out, as are the PM's (read-only by role).
 */
export function sessionsKeepingLevel(
  sessions: readonly Session[],
  projectId: string,
  level: AutonomyLevel,
): Session[] {
  return sessions.filter(
    (s) =>
      s.projectId === projectId &&
      s.role === "agent" &&
      !s.archivedAt &&
      !ENDED.includes(s.status) &&
      s.autonomy !== level,
  );
}
