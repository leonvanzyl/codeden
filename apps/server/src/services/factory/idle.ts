import type { FactoryTuning, Session } from "@codeden/contracts";

/**
 * Whether an agent the factory reminded of its step (a nudge sent at `nudgedAt`) has really
 * stopped: it took a turn since the nudge and has stayed idle for the grace period
 * (`idleGraceMin`) after it.
 *
 * A turn end alone doesn't mean that. An agent waiting on its own background command (an
 * install, a build, a test run) ends its turn and is woken when the command exits. If the nudge
 * reaches it meanwhile, it answers that it is still waiting and ends its turn again. Once the
 * command finishes, the session is busy again and its next turn end starts a new grace period.
 */
export function stoppedSinceNudge(
  session: Pick<Session, "updatedAt">,
  nudgedAt: string,
  now: Date,
  tuning: Pick<FactoryTuning, "idleGraceMin">,
): boolean {
  const lastTurn = Date.parse(session.updatedAt);
  if (lastTurn <= Date.parse(nudgedAt)) return false;
  return now.getTime() - lastTurn >= tuning.idleGraceMin * 60_000;
}
