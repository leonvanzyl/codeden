import type { FollowupSuggestion } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/common/bits";
import { SessionComposer } from "@/components/composer/composer";
import { ArchivedRoleNotice, isArchivedRole } from "@/components/orchestration/start-fresh";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import {
  useEarlierTurns,
  useProjectArchived,
  useSessionLookup,
  useSnapshotData,
  useTranscript,
} from "@/lib/queries";
import { checksRunning } from "@/lib/transcript/checks";
import { activeTurn } from "@/lib/transcript/reducer";
import { latestFollowups } from "@/lib/transcript/timeline";
import { useComposerStore } from "@/stores/composer";
import { useLayoutStore } from "@/stores/layout";
import { useNewSessionStore } from "@/stores/new-session";
import { FirstMessage } from "./first-message";
import { McpNotice } from "./mcp-notice";
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

/**
 * The centre column for a session: header, transcript, follow-ups and composer.
 * `focusItemId` opens the transcript at that item instead of the end.
 */
export function ThreadView({
  sessionId,
  empty,
  focusItemId,
}: {
  sessionId: string;
  empty?: React.ReactNode;
  focusItemId?: string;
}) {
  const navigate = useNavigate();
  // An older archived session isn't in the snapshot: it is fetched by id.
  const { session, loading } = useSessionLookup(sessionId);
  const { transcript, focusedTranscript, isLoading, error } = useTranscript(sessionId, {
    item: focusItemId,
  });
  const history = focusItemId && !transcript?.items[focusItemId] ? focusedTranscript : undefined;
  const visibleTranscript = history ?? transcript;
  const earlier = useEarlierTurns(sessionId);
  const threadId = transcript?.rootThreadId ?? session?.rootThreadId ?? null;
  const running = Boolean(transcript && threadId && activeTurn(transcript, threadId));
  const checking = Boolean(transcript && threadId && checksRunning(transcript, threadId));
  const followups = useMemo(
    () => (transcript && threadId ? latestFollowups(transcript, threadId) : null),
    [transcript, threadId],
  );
  const hasItems = Boolean(
    visibleTranscript && threadId && (visibleTranscript.threads[threadId]?.itemIds.length ?? 0) > 0,
  );
  // Sent from the New session draft: shown until the transcript has the turn.
  const firstMessage = useNewSessionStore((s) => s.firstMessages[sessionId]);
  // An archived project's sessions are read-only: no follow-ups to send.
  const archived = useProjectArchived(session?.projectId);

  const showLatest = () => {
    const { childThread, rightTab } = useLayoutStore.getState();
    if (
      childThread?.sessionId === sessionId &&
      history?.threads[childThread.threadId] &&
      !transcript?.threads[childThread.threadId]
    ) {
      useLayoutStore.setState({
        childThread: null,
        ...(rightTab === "thread" ? { rightTab: "diff", rightSheetOpen: false } : {}),
      });
    }
    void navigate({ to: "/sessions/$sessionId", params: { sessionId }, search: {} });
  };

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
    if (loading) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="h-12 shrink-0 border-b border-border" />
          <TranscriptSkeleton />
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
      <McpNotice session={session} />
      {history && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-1 text-xs text-muted-foreground">
          <span>Earlier turn</span>
          <Button variant="ghost" size="sm" onClick={showLatest}>
            Back to latest
          </Button>
        </div>
      )}
      {error ? (
        <EmptyState icon={<Sparkles />} title="Couldn't load this session" className="flex-1">
          {error.message}
        </EmptyState>
      ) : hasItems && visibleTranscript && threadId ? (
        <Transcript
          key={history ? focusItemId : "live"}
          transcript={visibleTranscript}
          threadId={threadId}
          sessionId={sessionId}
          focusItemId={focusItemId}
          earlier={history ? undefined : earlier}
        />
      ) : firstMessage ? (
        <FirstMessage input={firstMessage} status={session.status} />
      ) : isLoading || !transcript || !threadId ? (
        <div className="flex-1">
          <TranscriptSkeleton />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{empty}</div>
      )}
      {isArchivedRole(session) ? (
        // A newer session holds the role: this conversation is read-only (§8.1).
        <ArchivedRoleNotice session={session} />
      ) : (
        !history && (
          <>
            {followups && !running && !archived && (
              <FollowupChips sessionId={sessionId} suggestions={followups} />
            )}
            <QueuedMessages session={session} running={running} />
            <SessionComposer session={session} running={running} checking={checking} />
          </>
        )
      )}
    </div>
  );
}
