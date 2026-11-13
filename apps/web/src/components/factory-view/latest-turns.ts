import type { TranscriptState } from "@/lib/transcript/reducer";

/**
 * The transcript cut to its latest `keep` turns on one thread, for the Factory view's quick
 * chat: the thread lists only those turns and their items, so the shared transcript rendering
 * draws just the last few messages. Everything else is left as it is (subagent threads, turn
 * records), so rows render exactly as in the full chat. `hidden` is how many turns were cut.
 */
export function latestTurns(
  transcript: TranscriptState,
  threadId: string,
  keep: number,
): { transcript: TranscriptState; hidden: number } {
  const thread = transcript.threads[threadId];
  if (!thread || thread.turnIds.length <= keep) return { transcript, hidden: 0 };
  const turnIds = thread.turnIds.slice(-keep);
  const kept = new Set(turnIds);
  const itemIds = thread.itemIds.filter((id) => {
    const entry = transcript.items[id];
    return entry !== undefined && kept.has(entry.turnId);
  });
  return {
    transcript: {
      ...transcript,
      threads: { ...transcript.threads, [threadId]: { ...thread, turnIds, itemIds } },
    },
    hidden: thread.turnIds.length - keep,
  };
}
