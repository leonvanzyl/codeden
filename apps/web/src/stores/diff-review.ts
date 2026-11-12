import { create } from "zustand";
import { formatReviewMessage, type ReviewRange } from "@/lib/diff-review";

/** A line comment drafted in the Diff panel, waiting to be sent to the agent. */
export interface ReviewComment {
  id: string;
  path: string;
  /** The diff view it was written in (`diffScopeKey`); it shows inline only there. */
  scopeKey: string;
  range: ReviewRange;
  /** The covered diff rows, captured when the comment was started. */
  quote: string[];
  /** The saved text; empty until the comment is first saved. */
  body: string;
  /** The text in the open editor; undefined when the comment isn't being edited. */
  draft?: string;
}

/** A review on its way to the agent: what it holds, so only that is cleared when it lands. */
export interface SendingReview {
  /** The saved comments in the message, by id, with the text that was sent. */
  sent: Record<string, string>;
  /** Editors that were open and empty when it was sent: cleared too, if still empty. */
  empty: string[];
}

/** What `sendReview` did: sent, or why it sent nothing. */
export type SendReviewResult = "sent" | "busy" | "empty" | "unsaved";

interface DiffReviewState {
  /** Comments per session, in the order they were started. */
  comments: Record<string, ReviewComment[]>;
  /** The review in flight per session, if any. Lives here so leaving the panel keeps it. */
  sending: Record<string, SendingReview>;
  /** Start a comment with its editor open. */
  start: (sessionId: string, comment: Omit<ReviewComment, "id" | "body" | "draft">) => void;
  setDraft: (sessionId: string, id: string, text: string) => void;
  /** Save the editor's text; an empty text removes a comment that was never saved. */
  save: (sessionId: string, id: string) => void;
  /** Close the editor; a comment that was never saved is removed. */
  cancel: (sessionId: string, id: string) => void;
  edit: (sessionId: string, id: string) => void;
  remove: (sessionId: string, ids: string[]) => void;
  /** Discard every comment that isn't on its way to the agent. */
  clear: (sessionId: string) => void;
  /**
   * Send the saved comments as one review through `deliver`. One review per session is in
   * flight at a time, and its comments are locked until it settles. When it lands, the sent
   * comments and the editors that were empty are cleared; anything written since stays. When
   * it fails, everything stays and the error is thrown.
   */
  sendReview: (
    sessionId: string,
    deliver: (text: string) => Promise<void>,
  ) => Promise<SendReviewResult>;
}

let n = 0;
const nextId = () => `rc-${Date.now().toString(36)}-${n++}`;

const none: ReviewComment[] = [];

export function sessionComments(
  state: { comments: Record<string, ReviewComment[]> },
  sessionId: string,
): ReviewComment[] {
  return state.comments[sessionId] ?? none;
}

/** Saved comments: the ones that count and get sent. */
export function savedComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => c.body.trim() !== "");
}

/** An open editor whose text differs from what is saved: sending would leave it behind. */
export function hasUnsavedEdit(comments: ReviewComment[]): boolean {
  return comments.some((c) => c.draft !== undefined && c.draft.trim() !== c.body.trim());
}

/** Whether a comment is part of the review in flight, and so can't be changed. */
export function isSending(
  state: { sending: Record<string, SendingReview> },
  sessionId: string,
  id: string,
): boolean {
  return state.sending[sessionId]?.sent[id] !== undefined;
}

const isBlank = (c: ReviewComment) => !c.body.trim() && !(c.draft ?? "").trim();

/** A comment the landed review covers: sent as it still reads, or an editor still empty. */
function landed(c: ReviewComment, review: SendingReview): boolean {
  const sent = review.sent[c.id];
  if (sent !== undefined) {
    return c.body === sent && (c.draft === undefined || c.draft.trim() === c.body.trim());
  }
  return review.empty.includes(c.id) && isBlank(c);
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

/**
 * Draft line comments for each session's Diff panel. Held in memory like composer drafts, so
 * they survive switching panel tabs and sessions, and are cleared once sent or discarded.
 */
export const useDiffReviewStore = create<DiffReviewState>()((set, get) => {
  const change = (sessionId: string, fn: (list: ReviewComment[]) => ReviewComment[]) =>
    set((s) => ({ comments: { ...s.comments, [sessionId]: fn(sessionComments(s, sessionId)) } }));
  // Comments in the review in flight are left as they are.
  const patch = (sessionId: string, id: string, fn: (c: ReviewComment) => ReviewComment | null) => {
    if (isSending(get(), sessionId, id)) return;
    change(sessionId, (list) =>
      list.flatMap((c) => {
        if (c.id !== id) return [c];
        const next = fn(c);
        return next ? [next] : [];
      }),
    );
  };
  return {
    comments: {},
    sending: {},
    start: (sessionId, comment) =>
      change(sessionId, (list) => [...list, { ...comment, id: nextId(), body: "", draft: "" }]),
    setDraft: (sessionId, id, text) => patch(sessionId, id, (c) => ({ ...c, draft: text })),
    save: (sessionId, id) =>
      patch(sessionId, id, (c) => {
        const body = (c.draft ?? c.body).trim();
        if (!body) return c.body ? { ...c, draft: undefined } : null;
        return { ...c, body, draft: undefined };
      }),
    cancel: (sessionId, id) =>
      patch(sessionId, id, (c) => (c.body ? { ...c, draft: undefined } : null)),
    edit: (sessionId, id) => patch(sessionId, id, (c) => ({ ...c, draft: c.body })),
    remove: (sessionId, ids) => {
      const free = ids.filter((id) => !isSending(get(), sessionId, id));
      change(sessionId, (list) => list.filter((c) => !free.includes(c.id)));
    },
    clear: (sessionId) =>
      change(sessionId, (list) => list.filter((c) => isSending(get(), sessionId, c.id))),
    sendReview: async (sessionId, deliver) => {
      const state = get();
      if (state.sending[sessionId]) return "busy";
      const list = sessionComments(state, sessionId);
      if (hasUnsavedEdit(list)) return "unsaved";
      const saved = savedComments(list);
      if (saved.length === 0) return "empty";
      const review: SendingReview = {
        sent: Object.fromEntries(saved.map((c) => [c.id, c.body])),
        empty: list.filter(isBlank).map((c) => c.id),
      };
      set((s) => ({ sending: { ...s.sending, [sessionId]: review } }));
      try {
        await deliver(formatReviewMessage(saved));
      } catch (error) {
        set((s) => ({ sending: without(s.sending, sessionId) }));
        throw error;
      }
      set((s) => ({
        sending: without(s.sending, sessionId),
        comments: {
          ...s.comments,
          [sessionId]: sessionComments(s, sessionId).filter((c) => !landed(c, review)),
        },
      }));
      return "sent";
    },
  };
});
