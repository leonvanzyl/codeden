import type { ForkOrigin } from "@codeden/contracts";

/**
 * How a fork describes where it came from (§9): `upTo` finishes "the conversation and the code
 * …" in its empty transcript; `code` and `conversation` are its Details lines. A fork from a
 * turn names it by the source's turn number, never by a checkpoint number (a checkpoint that
 * failed to write takes none, so the two can differ); without one it names no number.
 */
export function forkOriginText(origin: ForkOrigin): {
  upTo: string;
  code: string;
  conversation: string | null;
} {
  const n = origin.turnNumber ?? null;
  if (origin.turnId) {
    return {
      upTo: n ? `as they were after turn ${n}` : "as they were after the turn it was forked from",
      code:
        origin.checkpoint === null
          ? "Code: its branch"
          : n
            ? `Code: its files after turn ${n}`
            : "Code: its files at the end of that turn",
      conversation: n
        ? `Conversation: up to the end of turn ${n}`
        : "Conversation: up to the end of the turn it was forked from",
    };
  }
  return {
    upTo: "so far",
    code:
      origin.checkpoint === null
        ? "Code: its branch"
        : origin.checkpoint === 0
          ? "Code: its files when it started"
          : `Code: its files after turn ${origin.checkpoint}`,
    conversation: null,
  };
}
