import { create } from "zustand";
import type { ReviewRange } from "@/lib/diff-review";

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

interface DiffReviewState {
  /** Comments per session, in the order they were started. */
  comments: Record<string, ReviewComment[]>;
  /** Start a comment with its editor open. */
  start: (sessionId: string, comment: Omit<ReviewComment, "id" | "body" | "draft">) => void;
  setDraft: (sessionId: string, id: string, text: string) => void;
  /** Save the editor's text; an empty text removes a comment that was never saved. */
  save: (sessionId: string, id: string) => void;
  /** Close the editor; a comment that was never saved is removed. */
  cancel: (sessionId: string, id: string) => void;
  edit: (sessionId: string, id: string) => void;
  remove: (sessionId: string, ids: string[]) => void;
  clear: (sessionId: string) => void;
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

/**
 * Draft line comments for each session's Diff panel. Held in memory like composer drafts, so
 * they survive switching panel tabs and sessions, and are cleared once sent or discarded.
 */
export const useDiffReviewStore = create<DiffReviewState>()((set) => {
  const change = (sessionId: string, fn: (list: ReviewComment[]) => ReviewComment[]) =>
    set((s) => ({ comments: { ...s.comments, [sessionId]: fn(sessionComments(s, sessionId)) } }));
  const patch = (sessionId: string, id: string, fn: (c: ReviewComment) => ReviewComment | null) =>
    change(sessionId, (list) =>
      list.flatMap((c) => {
        if (c.id !== id) return [c];
        const next = fn(c);
        return next ? [next] : [];
      }),
    );
  return {
    comments: {},
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
    remove: (sessionId, ids) =>
      change(sessionId, (list) => list.filter((c) => !ids.includes(c.id))),
    clear: (sessionId) => change(sessionId, () => none),
  };
});
