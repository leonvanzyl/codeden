import type { ForkOrigin, Session } from "@codeden/contracts";

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
    // A handoff starts a new conversation, possibly on another provider (§9).
    conversation:
      origin.kind === "handoff" ? "Conversation: a new one, opened with a brief of its work" : null,
  };
}

/** Whether a session was handed off from another (a new conversation), not forked. */
export const isHandoff = (origin: ForkOrigin) => origin.kind === "handoff";

/** How a session is related to the one whose diff is open. */
export type ForkRelation = "source" | "fork" | "handoff" | "sibling";

/** A session whose code the Diff panel can compare with, and how it is related. */
export interface RelatedSession {
  session: Session;
  relation: ForkRelation;
}

const newestFirst = (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt);

/**
 * The sessions `session`'s code can be compared with (§12.3), in this order: the one it was
 * forked or handed off from, the ones forked or handed off from it, and its siblings (other
 * forks and handoffs of its source), each group newest first. Only the same project's.
 */
export function relatedSessions(session: Session, all: readonly Session[]): RelatedSession[] {
  if (!session.projectId) return [];
  const candidates = all.filter((s) => s.id !== session.id && s.projectId === session.projectId);
  const sourceId = session.forkedFrom?.sessionId;
  const source = candidates.find((s) => s.id === sourceId);
  const children = candidates
    .filter((s) => s.forkedFrom?.sessionId === session.id)
    .sort(newestFirst)
    .map(
      (s): RelatedSession => ({
        session: s,
        relation: s.forkedFrom && isHandoff(s.forkedFrom) ? "handoff" : "fork",
      }),
    );
  const siblings = sourceId
    ? candidates
        .filter((s) => s.forkedFrom?.sessionId === sourceId)
        .sort(newestFirst)
        .map((s): RelatedSession => ({ session: s, relation: "sibling" }))
    : [];
  return [
    ...(source ? [{ session: source, relation: "source" as const }] : []),
    ...children,
    ...siblings,
  ];
}
