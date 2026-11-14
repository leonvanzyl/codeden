import type { ForkOrigin, Session, StartedBy } from "@codeden/contracts";

/**
 * Who started the work `session` carries on (§9, #248): the starter its fork or handoff
 * recorded from the source (`forkedFrom.startedBy`), else its own `startedBy`. A fork or a
 * handoff is started by the user, but the work it continues, and the issue text in it, is still
 * the factory's, an automation's or a PM's. PR feedback goes by this, never by `startedBy` alone.
 */
export function workStarter(session: Pick<Session, "startedBy" | "forkedFrom">): StartedBy {
  return session.forkedFrom?.startedBy ?? session.startedBy;
}

/** What a fork or handoff of `source` records of its work's starter: nothing when the user's. */
export function inheritedStarter(
  source: Pick<Session, "startedBy" | "forkedFrom">,
): Pick<ForkOrigin, "startedBy"> {
  const starter = workStarter(source);
  return starter.kind === "user" ? {} : { startedBy: starter };
}
