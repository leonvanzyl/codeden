import type { Session } from "@codeden/contracts";
import { GitFork } from "lucide-react";
import { useSession } from "@/lib/queries";
import { useForkSession } from "@/lib/session-actions";
import type { TimelineRow } from "@/lib/transcript/timeline";

type TurnEnd = Extract<TimelineRow, { type: "turn-end" }>;

/**
 * Whether a finished turn can be forked from (§9): a turn of the session's own thread that is
 * its latest (the whole conversation) or recorded where its conversation ended (`forkPoint`).
 */
export const forkableTurn = (session: Session, row: TurnEnd) =>
  row.turn.threadId === session.rootThreadId &&
  row.turn.status !== "running" &&
  (row.latest || Boolean(row.turn.forkPoint));

/**
 * "Fork from here" on a finished turn's footer: a new session whose conversation ends with
 * this turn and whose code is this turn's checkpoint. Shown on hover (always on touch) when the
 * provider can fork; while it can't fork right now, it says why instead.
 */
export function ForkFromHere({ sessionId, row }: { sessionId: string; row: TurnEnd }) {
  const session = useSession(sessionId);
  if (!session || !forkableTurn(session, row)) return null;
  return <ForkButton session={session} turnId={row.turn.id} />;
}

function ForkButton({ session, turnId }: { session: Session; turnId: string }) {
  const fork = useForkSession(session);
  if (!fork.canFork) return null;
  const blocked = fork.blocked;
  return (
    <button
      type="button"
      aria-disabled={blocked !== null}
      title={
        blocked ?? "A new session with the conversation and the code as they were after this turn"
      }
      onClick={() => {
        if (blocked === null) fork.fork(turnId);
      }}
      className="absolute right-0 flex items-center gap-1 bg-background pl-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 touch:opacity-100 aria-disabled:cursor-not-allowed aria-disabled:hover:text-muted-foreground"
    >
      <GitFork className="size-3" /> Fork from here
    </button>
  );
}
