import { FORK_POINT_MISSING, ProviderSessionError } from "../adapter";
import type { ClaudeSdkModule } from "./sdk";

/** The SDK functions a fork uses. */
export type ClaudeForkSdk = Pick<ClaudeSdkModule, "forkSession" | "getSessionMessages">;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Copy a Claude conversation with the SDK's `forkSession()`: the transcript is written to a new
 * session file at once (fresh message ids, the original untouched) and the new session id is
 * returned for resuming. With `upTo` (a turn's fork point: its last transcript message), the
 * transcript is read first (`getSessionMessages`) to confirm it still holds that message, and
 * the copy ends with it. A conversation that no longer holds it (replaced or deleted) throws
 * `FORK_POINT_MISSING` before anything is copied, so it never becomes a whole copy instead.
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
    throw new Error(`Could not fork the Claude conversation ${resumeToken}: ${reasonOf(error)}`);
  }
}

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
  if (!messages.some((m) => m.uuid === upTo)) {
    throw new ProviderSessionError(
      FORK_POINT_MISSING,
      "The conversation no longer holds the end of that turn (it was replaced or deleted), so it can't be forked there",
    );
  }
}
