import { FORK_POINT_MISSING, ProviderSessionError } from "../adapter";
import type { ClaudeSdkModule } from "./sdk";

/** The SDK functions a fork uses. */
export type ClaudeForkSdk = Pick<ClaudeSdkModule, "forkSession" | "getSessionMessages">;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Copy a Claude conversation with the SDK's `forkSession()`: the transcript is written to a new
 * session file at once (fresh message ids, the original untouched) and the new session id is
 * returned for resuming. With `upTo` (a turn's fork point: its last transcript message), the
 * copy ends with that message. A conversation that no longer holds it (replaced or deleted)
 * throws `FORK_POINT_MISSING` before anything is copied, so it never becomes a whole copy
 * instead: `confirmForkPoint` refuses it from the transcript read when it can, and otherwise
 * `forkSession()` does, as it slices the whole transcript file and refuses a message the file
 * doesn't hold before writing anything (SDK 0.3.318: `Message <uuid> not found in session <id>`).
 */
export async function forkClaudeConversation(
  sdk: ClaudeForkSdk,
  resumeToken: string,
  upTo?: string,
): Promise<string> {
  if (upTo) await confirmForkPoint(sdk, resumeToken, upTo);
  try {
    return (await sdk.forkSession(resumeToken, upTo ? { upToMessageId: upTo } : undefined))
      .sessionId;
  } catch (error) {
    if (upTo && refusedForkPoint(error, upTo)) throw forkPointMissing();
    throw new Error(`Could not fork the Claude conversation ${resumeToken}: ${reasonOf(error)}`);
  }
}

/**
 * Read the transcript (`getSessionMessages`) and refuse a fork point it doesn't hold. That read
 * follows `parentUuid` links back from the newest message, and a context compaction's boundary
 * has none, so in a compacted conversation it starts at the latest boundary (a `system`
 * message) and leaves out every earlier message, although the transcript file still holds
 * them. A fork point missing from such a read may be before the compaction, so `forkSession()`
 * decides then. An empty read (a conversation that was deleted) holds nothing.
 */
async function confirmForkPoint(
  sdk: ClaudeForkSdk,
  resumeToken: string,
  upTo: string,
): Promise<void> {
  let messages: Awaited<ReturnType<ClaudeForkSdk["getSessionMessages"]>>;
  try {
    messages = await sdk.getSessionMessages(resumeToken, { includeSystemMessages: true });
  } catch (error) {
    throw new Error(`Could not read the Claude conversation ${resumeToken}: ${reasonOf(error)}`);
  }
  const startsAtCompaction = messages[0]?.type === "system";
  if (!startsAtCompaction && !messages.some((m) => m.uuid === upTo)) throw forkPointMissing();
}

/** Whether `forkSession()` refused `upTo` as a message its transcript doesn't hold. */
function refusedForkPoint(error: unknown, upTo: string): boolean {
  const reason = reasonOf(error);
  return reason.includes(upTo) && /\bnot found\b/i.test(reason);
}

function forkPointMissing(): ProviderSessionError {
  return new ProviderSessionError(
    FORK_POINT_MISSING,
    "The conversation no longer holds the end of that turn (it was replaced or deleted), so it can't be forked there",
  );
}
