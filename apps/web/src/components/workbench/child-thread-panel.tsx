import { Bot } from "lucide-react";
import { Transcript } from "@/components/thread/transcript";
import { useTranscriptsStore } from "@/stores/transcripts";

/**
 * A subagent's child thread, shown beside its parent (§7.3); `focusItemId` (a search hit)
 * opens it at that item.
 */
export function ChildThreadPanel({
  sessionId,
  threadId,
  focusItemId,
}: {
  sessionId: string;
  threadId: string;
  focusItemId?: string;
}) {
  const transcript = useTranscriptsStore((s) => s.byId[sessionId]);
  const thread = transcript?.threads[threadId];
  if (!transcript || !thread) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-chart-4/12 text-chart-4">
          <Bot className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{thread.title ?? "Subagent"}</div>
          {thread.agentType && (
            <div className="font-mono text-3xs text-muted-foreground">{thread.agentType}</div>
          )}
        </div>
      </div>
      <Transcript
        transcript={transcript}
        threadId={threadId}
        sessionId={sessionId}
        focusItemId={focusItemId}
        contentClassName="max-w-none px-4 pt-4"
      />
    </div>
  );
}
