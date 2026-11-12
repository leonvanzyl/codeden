import type { DiffFile, Session, SessionStatus } from "@codeden/contracts";
import { MessageSquare, Pencil, SendHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import {
  anchorComments,
  labelCommentButtons,
  type ReviewAnchors,
  rangeLabel,
} from "@/lib/diff-review";
import { sendToSession } from "@/lib/send-to-session";
import {
  hasUnsavedEdit,
  isSending,
  isUnsavedEdit,
  type ReviewComment,
  savedComments,
  sessionComments,
  useDiffReviewStore,
} from "@/stores/diff-review";

const busyStatuses: SessionStatus[] = ["starting", "running", "waiting"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const noAnchors: ReviewAnchors = { byPath: {}, ranges: {}, outdated: [] };

/**
 * Where one view's comments go in its diff as it is now: under the lines they quote, wherever
 * those are after the diff changed, or listed as outdated (`anchorComments`). A comment that
 * moved takes its new range in the store, so it's labelled and sent with today's numbers.
 * Nothing is placed while `files` is null, the diff not loaded. Only comment ids are watched
 * (a range changes only through this hook, the quote never), so typing in a comment never
 * re-renders the diff itself.
 */
export function useReviewAnchors(
  sessionId: string,
  scopeKey: string,
  files: DiffFile[] | null,
): ReviewAnchors {
  const ids = useDiffReviewStore((s) =>
    sessionComments(s, sessionId)
      .filter((c) => c.scopeKey === scopeKey)
      .map((c) => c.id)
      .join(" "),
  );
  const anchors = useMemo(() => {
    if (!files || !ids) return noAnchors;
    const wanted = new Set(ids.split(" "));
    const comments = sessionComments(useDiffReviewStore.getState(), sessionId);
    return anchorComments(
      comments.filter((c) => wanted.has(c.id)),
      files,
    );
  }, [ids, files, sessionId]);
  useEffect(() => {
    useDiffReviewStore.getState().move(sessionId, anchors.ranges);
  }, [sessionId, anchors]);
  return anchors;
}

/**
 * A ref for a file's diff card that labels the diff's "+" (see `labelCommentButtons`). The
 * diff inserts the button in its own `pointermove` handler, inside its shadow root; the same
 * event then bubbles out to this card, so the button is labelled the moment it first shows.
 * (`pointerover` won't do: it fires before the insertion, and moving from a line onto the
 * button stays inside the shadow root, so that one never reaches the card.)
 */
export function useCommentButtonLabels() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const label = () => labelCommentButtons(el);
    el.addEventListener("pointermove", label);
    el.addEventListener("focusin", label);
    return () => {
      el.removeEventListener("pointermove", label);
      el.removeEventListener("focusin", label);
    };
  }, []);
  return ref;
}

/**
 * The comments under one diff line, by the ids its anchor carries: open editors and saved
 * comments, in the order started.
 */
export function LineComments({ sessionId, ids }: { sessionId: string; ids: string[] }) {
  const all = useDiffReviewStore((s) => sessionComments(s, sessionId));
  const here = all.filter((c) => ids.includes(c.id));
  if (here.length === 0) return null;
  return (
    <div className="space-y-1.5 px-2 py-1.5 font-sans whitespace-normal">
      {here.map((c) => (
        <CommentCard key={c.id} sessionId={sessionId} comment={c} />
      ))}
    </div>
  );
}

/**
 * This view's comments whose lines are no longer in its diff (the agent changed or reverted
 * them, or they were committed), above the files. Each keeps its quote, is still sent with the
 * lines as they were, and can be edited or deleted on its own.
 */
export function OutdatedComments({ sessionId, ids }: { sessionId: string; ids: string[] }) {
  const all = useDiffReviewStore((s) => sessionComments(s, sessionId));
  const outdated = all.filter((c) => ids.includes(c.id));
  if (outdated.length === 0) return null;
  return (
    <section
      aria-label="Outdated comments"
      className="space-y-1.5 rounded-lg border border-dashed border-border p-2"
    >
      <p className="px-0.5 text-2xs text-muted-foreground">
        <span className="font-medium text-foreground">Outdated</span> · no longer in this diff.
        Still sent, quoting the lines as they were.
      </p>
      {outdated.map((c) => (
        <CommentCard key={c.id} sessionId={sessionId} comment={c} outdated />
      ))}
    </section>
  );
}

/**
 * Focus a new editor, caret at the end. The diff shows an annotation only after it lays out
 * its slot, a frame or so after React mounts it, so `autoFocus` would find it hidden.
 */
function focusWhenShown(el: HTMLTextAreaElement | null) {
  if (!el) return;
  let tries = 0;
  const attempt = () => {
    if (!el.isConnected) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    if (document.activeElement !== el && ++tries < 5) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** A comment, saved or with its editor open. An outdated one also names its file and quote. */
function CommentCard({
  sessionId,
  comment,
  outdated = false,
}: {
  sessionId: string;
  comment: ReviewComment;
  outdated?: boolean;
}) {
  const { setDraft, save, cancel, edit, remove } = useDiffReviewStore.getState();
  // A comment on its way to the agent reads as sent: no editing until the review settles.
  const locked = useDiffReviewStore((s) => isSending(s, sessionId, comment.id));
  const label = rangeLabel(comment.range);
  const editing = comment.draft !== undefined && !locked;
  return (
    <div
      className="max-w-[46rem] rounded-lg border border-border bg-card text-xs text-foreground shadow-xs"
      data-testid="diff-comment"
      data-comment-id={comment.id}
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-3xs text-muted-foreground">
        <MessageSquare className="size-3" />
        <span className="flex-1 truncate">
          {outdated ? `${comment.path}, ${label}` : `Comment on ${label}`}
        </span>
        {locked && <span className="py-1">Sending…</span>}
        {!editing && !locked && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Edit comment"
              title="Edit"
              onClick={() => edit(sessionId, comment.id)}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Delete comment"
              title="Delete"
              onClick={() => remove(sessionId, [comment.id])}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {outdated && comment.quote.length > 0 && (
        <pre className="mx-2.5 mt-1 max-h-24 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-3xs leading-relaxed text-muted-foreground scroll-thin">
          {comment.quote.join("\n")}
        </pre>
      )}
      {editing ? (
        <div className="space-y-1.5 p-2 pt-1">
          <Textarea
            ref={focusWhenShown}
            aria-label={`Comment on ${label}`}
            placeholder="What should the agent change here?"
            value={comment.draft}
            onChange={(e) => setDraft(sessionId, comment.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancel(sessionId, comment.id);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save(sessionId, comment.id);
              }
            }}
            className="min-h-16 text-xs"
          />
          <div className="flex gap-1.5">
            <Button
              size="xs"
              disabled={!comment.draft?.trim()}
              onClick={() => save(sessionId, comment.id)}
              title="Save the comment (Ctrl/Cmd+Enter)"
            >
              Comment
            </Button>
            <Button size="xs" variant="ghost" onClick={() => cancel(sessionId, comment.id)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="px-2.5 pt-0.5 pb-2 leading-relaxed whitespace-pre-wrap">{comment.body}</p>
      )}
    </div>
  );
}

/**
 * The review bar under the Diff panel toolbar while comments are drafted: how many, across
 * every file and view, with Send to agent and Discard. Sending makes them one message, sent
 * now or queued behind a running turn like any message. An unsaved editor holds Send back;
 * when it isn't on screen (another view, or a diff that didn't load), the bar says so and
 * offers Show (`onShow`: switch to its view and scroll to it) and Cancel.
 */
export function ReviewBar({
  session,
  scopeKey,
  diffShown = true,
  onShow,
}: {
  session: Session;
  scopeKey: string;
  /** Whether this view's diff is on screen, and so its comments (inline or outdated). */
  diffShown?: boolean;
  onShow?: (comment: ReviewComment) => void;
}) {
  const client = useClient();
  const all = useDiffReviewStore((s) => sessionComments(s, session.id));
  // In the store, not this component: leaving the panel mid-send keeps Send disabled.
  const sending = useDiffReviewStore((s) => s.sending[session.id] !== undefined);
  const saved = savedComments(all);
  const unsaved = hasUnsavedEdit(all);
  const elsewhere = saved.filter((c) => c.scopeKey !== scopeKey).length;
  const hidden = all.filter((c) => isUnsavedEdit(c) && !(diffShown && c.scopeKey === scopeKey));
  const otherView = hidden.find((c) => c.scopeKey !== scopeKey);
  const cancelHidden = () => {
    const what = hidden.length === 1 ? "the unsaved comment" : `${hidden.length} unsaved comments`;
    if (!window.confirm(`Cancel ${what}? What you typed is lost.`)) return;
    for (const c of hidden) useDiffReviewStore.getState().cancel(session.id, c.id);
  };
  const send = () => {
    const busy = busyStatuses.includes(session.status);
    useDiffReviewStore
      .getState()
      .sendReview(session.id, (text) => sendToSession(client, session, { text }, "queue"))
      .then((result) => {
        if (result !== "sent") return;
        if (busy) toast("Review queued", { description: "It's sent when the current turn ends." });
        else toast("Review sent to the agent");
      })
      .catch((e: Error) => toast.error("Review not sent", { description: e.message }));
  };
  if (saved.length === 0) return null;
  return (
    <div
      className="shrink-0 border-b border-border bg-primary/[0.06]"
      data-testid="diff-review-bar"
    >
      <div className="flex h-9 items-center gap-1.5 px-3 text-xs pointer-coarse:h-auto pointer-coarse:min-h-11">
        <MessageSquare className="size-3.5 text-primary" />
        <span className="font-medium tabular-nums" aria-live="polite">
          {plural(saved.length, "comment")}
        </span>
        {elsewhere > 0 && (
          <span className="truncate text-2xs text-muted-foreground">
            ({elsewhere} in another view)
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            disabled={sending}
            onClick={() => {
              if (window.confirm(`Discard ${plural(all.length, "draft comment")}?`))
                useDiffReviewStore.getState().clear(session.id);
            }}
          >
            Discard
          </Button>
          <Button
            size="sm"
            className="text-xs"
            disabled={sending || unsaved}
            title={
              unsaved
                ? "Save or cancel the comment you're editing first"
                : "Send every comment to the agent as one message"
            }
            onClick={send}
          >
            <SendHorizontal /> {sending ? "Sending…" : "Send to agent"}
          </Button>
        </div>
      </div>
      {hidden.length > 0 && (
        <div className="flex min-h-8 items-center gap-1.5 px-3 pb-1.5 text-2xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-status-waiting" />
          <span
            className="min-w-0 flex-1 truncate"
            role="status"
            title="Save or cancel it to send the review"
          >
            {hidden.length === 1 ? "An unsaved comment" : `${hidden.length} unsaved comments`}{" "}
            {otherView ? "in another view" : "not shown here"}
          </span>
          {otherView && onShow && (
            <Button size="xs" variant="outline" onClick={() => onShow(otherView)}>
              Show
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={cancelHidden}>
            {hidden.length === 1 ? "Cancel edit" : "Cancel edits"}
          </Button>
        </div>
      )}
    </div>
  );
}
