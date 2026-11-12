import type { FollowupSuggestion } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/common/bits";
import { SessionComposer } from "@/components/composer/composer";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { useSession, useSnapshotData, useTranscript } from "@/lib/queries";
import { activeTurn } from "@/lib/transcript/reducer";
import { latestFollowups } from "@/lib/transcript/timeline";
import { useComposerStore } from "@/stores/composer";
import { useNewSessionStore } from "@/stores/new-session";
import { FirstMessage } from "./first-message";
import { QueuedMessages } from "./queued-messages";
import { ThreadHeader } from "./thread-header";
import { Transcript } from "./transcript";

/** Follow-up chips above the composer after a turn completes (§7.5). */
function FollowupChips({
  sessionId,
  suggestions,
}: {
  sessionId: string;
  suggestions: FollowupSuggestion[];
}) {
  const client = useClient();
  const sendOnClick = useSnapshotData((s) => s.settings.followups.sendOnClick, false);
  const setText = useComposerStore((s) => s.setText);
  const focus = useComposerStore((s) => s.focus);
  const send = useMutation({
    mutationFn: (prompt: string) => client.sendMessage(sessionId, { text: prompt }, "send"),
  });
  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-wrap items-center gap-1.5 px-6 pb-2">
      <Sparkles className="mr-0.5 size-3.5 text-primary/70" />
      {suggestions.map((s) => (
        <button
          key={s.prompt}
          type="button"
          title={s.prompt}
          onClick={() => {
            if (sendOnClick) send.mutate(s.prompt);
            else {
              setText(sessionId, s.prompt);
              focus();
            }
          }}
          className="h-7 max-w-64 truncate rounded-full border border-border bg-card/70 px-3 text-xs text-muted-foreground shadow-xs transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
        >
          {s.label ?? s.prompt}
        </button>
      ))}
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[46rem] space-y-5 px-6 pt-8">
      <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

/** The centre column for a session: header, transcript, follow-ups and composer. */
export function ThreadView({ sessionId, empty }: { sessionId: string; empty?: React.ReactNode }) {
  const session = useSession(sessionId);
  const { transcript, isLoading, error } = useTranscript(sessionId);
  const threadId = transcript?.rootThreadId ?? session?.rootThreadId ?? null;
  const running = Boolean(transcript && threadId && activeTurn(transcript, threadId));
  const followups = useMemo(
    () => (transcript && threadId ? latestFollowups(transcript, threadId) : null),
    [transcript, threadId],
  );
  const hasItems = Boolean(
    transcript && threadId && (transcript.threads[threadId]?.itemIds.length ?? 0) > 0,
  );
  // Sent from the New session draft: shown until the transcript has the turn.
  const firstMessage = useNewSessionStore((s) => s.firstMessages[sessionId]);

  if (!session) {
    // Just started from the draft and not in the snapshot yet: its realtime event is on the way.
    if (firstMessage) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="h-12 shrink-0 border-b border-border" />
          <FirstMessage input={firstMessage} status="starting" />
        </div>
      );
    }
    return (
      <EmptyState icon={<Sparkles />} title="Session not found" className="flex-1">
        It may have been archived.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader session={session} running={running} />
      {error ? (
        <EmptyState icon={<Sparkles />} title="Couldn't load this session" className="flex-1">
          {error.message}
        </EmptyState>
      ) : hasItems && transcript && threadId ? (
        <Transcript transcript={transcript} threadId={threadId} sessionId={sessionId} />
      ) : firstMessage ? (
        <FirstMessage input={firstMessage} status={session.status} />
      ) : isLoading || !transcript || !threadId ? (
        <div className="flex-1">
          <TranscriptSkeleton />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{empty}</div>
      )}
      {followups && !running && <FollowupChips sessionId={sessionId} suggestions={followups} />}
      <QueuedMessages session={session} running={running} />
      <SessionComposer session={session} running={running} />
    </div>
  );
}
