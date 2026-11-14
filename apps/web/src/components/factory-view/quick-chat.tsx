import type { Session } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot } from "lucide-react";
import { useMemo } from "react";
import { SessionComposer } from "@/components/composer/composer";
import { StartComposer, useRoleSession } from "@/components/orchestration/role-chat";
import { QueuedMessages } from "@/components/thread/queued-messages";
import { Transcript } from "@/components/thread/transcript";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranscript } from "@/lib/queries";
import { activeTurn } from "@/lib/transcript/reducer";
import { latestTurns } from "./latest-turns";

/** Turns the quick chat shows; the full chat has the rest. */
const LATEST_TURNS = 3;

/** The PM session's latest turns, streamed like any session, and its composer. */
function PmThread({ session, projectId }: { session: Session; projectId: string }) {
  const { transcript, isLoading } = useTranscript(session.id);
  const threadId = transcript?.rootThreadId ?? session.rootThreadId ?? null;
  const running = Boolean(transcript && threadId && activeTurn(transcript, threadId));
  const latest = useMemo(
    () => (transcript && threadId ? latestTurns(transcript, threadId, LATEST_TURNS) : null),
    [transcript, threadId],
  );
  const hasItems = Boolean(
    latest && threadId && (latest.transcript.threads[threadId]?.itemIds.length ?? 0) > 0,
  );
  return (
    <>
      {latest && latest.hidden > 0 && (
        <Link
          to="/projects/$projectId/pm"
          params={{ projectId }}
          className="shrink-0 border-b border-border px-3 py-1.5 text-center text-3xs text-muted-foreground hover:text-foreground"
          data-testid="factory-view-chat-earlier"
        >
          {latest.hidden} earlier {latest.hidden === 1 ? "turn" : "turns"} in the full chat
        </Link>
      )}
      {hasItems && latest && threadId ? (
        <Transcript
          transcript={latest.transcript}
          threadId={threadId}
          sessionId={session.id}
          contentClassName="max-w-none px-3 pt-3 pb-2 text-[13px]"
        />
      ) : isLoading ? (
        <div className="flex-1 space-y-3 p-3">
          <Skeleton className="ml-auto h-8 w-2/3 rounded-xl" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : (
        <p className="flex-1 p-3 text-2xs text-muted-foreground">No messages yet.</p>
      )}
      <QueuedMessages session={session} running={running} />
      <SessionComposer session={session} running={running} />
    </>
  );
}

/**
 * A quick line to the project's PM from the Factory view: its latest messages and the session
 * composer (the start composer while there is no PM yet). The full chat is one click away.
 */
export function QuickChat({
  projectId,
  onCollapse,
  header = true,
}: {
  projectId: string;
  /** Shown as a "Hide" button when the chat can collapse. */
  onCollapse?: () => void;
  /** Its own header; pixel mode's terminal draws one of its own. */
  header?: boolean;
}) {
  const session = useRoleSession("pm", projectId);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="factory-view-chat">
      <header
        className={
          header ? "flex h-10 shrink-0 items-center gap-2 border-b border-border px-3" : "hidden"
        }
      >
        <Bot className="size-4 text-primary" aria-hidden />
        <h2 className="text-[13px] font-medium">Project manager</h2>
        {session && (
          <span className="text-3xs text-muted-foreground">
            {session.status === "running" ? "answering…" : null}
          </span>
        )}
        <Link
          to="/projects/$projectId/pm"
          params={{ projectId }}
          className="ml-auto inline-flex items-center gap-0.5 text-2xs text-primary hover:underline"
        >
          Open full chat <ArrowUpRight className="size-3" aria-hidden />
        </Link>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="text-2xs text-muted-foreground hover:text-foreground"
          >
            Hide
          </button>
        )}
      </header>
      {session ? (
        <PmThread session={session} projectId={projectId} />
      ) : (
        <>
          <p className="flex-1 p-3 text-2xs text-muted-foreground">
            Ask the PM what the factory is doing, or to let an issue in. Your first message starts
            it.
          </p>
          <StartComposer kind="pm" projectId={projectId} />
        </>
      )}
    </div>
  );
}
