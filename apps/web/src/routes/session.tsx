import type { ForkOrigin } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, GitFork, MessageSquareDashed } from "lucide-react";
import { useEffect } from "react";
import { EmptyState } from "@/components/common/bits";
import { ThreadView } from "@/components/thread/thread-view";
import { forkOriginText, isHandoff } from "@/lib/fork-origin";
import { useSession } from "@/lib/queries";
import { useLayoutStore } from "@/stores/layout";

/**
 * A new fork's empty transcript: where it came from and that the agent remembers it. A handoff
 * says its brief is on the way instead (§9).
 */
function ForkedEmpty({ origin }: { origin: ForkOrigin }) {
  const sourceId = origin.sessionId;
  const source = useSession(sourceId);
  // Forked from a turn ("Fork from here"): the conversation and code end with that turn.
  const { upTo } = forkOriginText(origin);
  if (isHandoff(origin)) {
    return (
      <EmptyState icon={<ArrowRightLeft />} title="Handed-off session" className="flex-1">
        Continues{" "}
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: sourceId }}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          {source ? (source.title ?? source.purpose) : "another session"}
        </Link>{" "}
        with its code so far, in its own worktree and branch. Once the worktree is ready, CodeDen
        sends the agent a brief of the work as its first message. The original session is unchanged.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<GitFork />} title="Forked session" className="flex-1">
      Forked from{" "}
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: sourceId }}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {source ? (source.title ?? source.purpose) : "another session"}
      </Link>
      . The agent has the conversation and the code {upTo}, in its own worktree and branch. Send a
      message to continue; the original session is unchanged.
    </EmptyState>
  );
}

/**
 * Any agent or PM session; `focusItemId` opens the transcript at that item, and `focusThread`
 * (a search hit inside a subagent's thread) also opens that thread beside it at the item.
 */
export function SessionPage({
  sessionId,
  focusItemId,
  focusThread,
}: {
  sessionId: string;
  focusItemId?: string;
  focusThread?: { threadId: string; itemId: string };
}) {
  const forkedFrom = useSession(sessionId)?.forkedFrom;
  const openChildThread = useLayoutStore((s) => s.openChildThread);
  const childThreadId = focusThread?.threadId;
  const childItemId = focusThread?.itemId;
  useEffect(() => {
    if (childThreadId && childItemId) openChildThread(sessionId, childThreadId, childItemId);
  }, [sessionId, childThreadId, childItemId, openChildThread]);
  return (
    <ThreadView
      key={sessionId}
      sessionId={sessionId}
      focusItemId={focusItemId}
      empty={
        forkedFrom ? (
          <ForkedEmpty origin={forkedFrom} />
        ) : (
          <EmptyState icon={<MessageSquareDashed />} title="No messages yet" className="flex-1">
            Describe the task. The agent works in its own worktree and branch.
          </EmptyState>
        )
      }
    />
  );
}
