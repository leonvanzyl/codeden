import type { Session } from "@codeden/contracts";
import { GitFork } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
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
 * this turn and whose code is this turn's checkpoint. Shown on hover when the provider can fork.
 * On touch screens it is always shown, in line after the turn's summary rather than over it.
 */
export function ForkFromHere({ sessionId, row }: { sessionId: string; row: TurnEnd }) {
  const session = useSession(sessionId);
  if (!session || !forkableTurn(session, row)) return null;
  return <ForkButton session={session} turnId={row.turn.id} />;
}

/**
 * While it can't fork right now, pressing it (click, tap, Enter or Space) says why in a toast,
 * and the reason is its description for assistive tech: a `title` tooltip shows neither on
 * touch nor on keyboard focus.
 */
function ForkButton({ session, turnId }: { session: Session; turnId: string }) {
  const fork = useForkSession(session);
  const reasonId = useId();
  if (!fork.canFork) return null;
  const blocked = fork.blocked;
  return (
    <>
      <button
        type="button"
        aria-disabled={blocked !== null}
        aria-describedby={blocked ? reasonId : undefined}
        title={
          blocked ?? "A new session with the conversation and the code as they were after this turn"
        }
        onClick={() => {
          if (blocked === null) fork.fork(turnId);
          // Already forking: its "Forking the session…" toast says so.
          else if (!fork.pending) toast(blocked, { id: `fork-blocked:${session.id}` });
        }}
        className="absolute right-0 flex shrink-0 items-center gap-1 bg-background pl-2 whitespace-nowrap text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 touch:static touch:pl-0 touch:opacity-100 aria-disabled:cursor-not-allowed aria-disabled:hover:text-muted-foreground"
      >
        <GitFork className="size-3" /> Fork from here
      </button>
      {blocked && (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}
