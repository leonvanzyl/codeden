import { Link } from "@tanstack/react-router";
import { GitFork, MessageSquareDashed } from "lucide-react";
import { EmptyState } from "@/components/common/bits";
import { ThreadView } from "@/components/thread/thread-view";
import { useSession } from "@/lib/queries";

/** A new fork's empty transcript: where it came from and that the agent remembers it. */
function ForkedEmpty({ sourceId }: { sourceId: string }) {
  const source = useSession(sourceId);
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
      . The agent has the conversation and the code so far, in its own worktree and branch. Send a
      message to continue; the original session is unchanged.
    </EmptyState>
  );
}

/** Any agent or PM session. */
export function SessionPage({ sessionId }: { sessionId: string }) {
  const forkedFrom = useSession(sessionId)?.forkedFrom;
  return (
    <ThreadView
      key={sessionId}
      sessionId={sessionId}
      empty={
        forkedFrom ? (
          <ForkedEmpty sourceId={forkedFrom.sessionId} />
        ) : (
          <EmptyState icon={<MessageSquareDashed />} title="No messages yet" className="flex-1">
            Describe the task. The agent works in its own worktree and branch.
          </EmptyState>
        )
      }
    />
  );
}
