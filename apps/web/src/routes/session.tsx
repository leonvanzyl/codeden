import type { ForkOrigin } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { GitFork, MessageSquareDashed } from "lucide-react";
import { EmptyState } from "@/components/common/bits";
import { ThreadView } from "@/components/thread/thread-view";
import { forkOriginText } from "@/lib/fork-origin";
import { useSession } from "@/lib/queries";

/** A new fork's empty transcript: where it came from and that the agent remembers it. */
function ForkedEmpty({ origin }: { origin: ForkOrigin }) {
  const sourceId = origin.sessionId;
  const source = useSession(sourceId);
  // Forked from a turn ("Fork from here"): the conversation and code end with that turn.
  const { upTo } = forkOriginText(origin);
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

/** Any agent or PM session; `focusItemId` opens the transcript at that item. */
export function SessionPage({
  sessionId,
  focusItemId,
}: {
  sessionId: string;
  focusItemId?: string;
}) {
  const forkedFrom = useSession(sessionId)?.forkedFrom;
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
