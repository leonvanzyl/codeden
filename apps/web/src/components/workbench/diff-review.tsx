import type { Session, SessionStatus } from "@codeden/contracts";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { useMutation } from "@tanstack/react-query";
import { MessageSquare, Pencil, SendHorizontal, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { type DiffSide, formatReviewMessage, rangeLabel } from "@/lib/diff-review";
import { sendToSession } from "@/lib/send-to-session";
import {
  hasUnsavedEdit,
  type ReviewComment,
  savedComments,
  sessionComments,
  useDiffReviewStore,
} from "@/stores/diff-review";

const busyStatuses: SessionStatus[] = ["starting", "running", "waiting"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Where one file's comments sit in one diff view, as diff annotations: one per line that has
 * comments, under the last line each covers. Only positions go in, so typing in a comment
 * never re-renders the diff itself.
 */
export function useReviewAnnotations(
  sessionId: string,
  path: string,
  scopeKey: string,
): DiffLineAnnotation[] {
  const spots = useDiffReviewStore((s) => {
    const seen = new Set<string>();
    for (const c of sessionComments(s, sessionId)) {
      if (c.path === path && c.scopeKey === scopeKey) seen.add(`${c.range.endSide}:${c.range.end}`);
    }
    return [...seen].join(",");
  });
  return useMemo(
    () =>
      spots
        ? spots.split(",").map((spot) => {
            const [side, line] = spot.split(":");
            return { side: side as DiffSide, lineNumber: Number(line) };
          })
        : [],
    [spots],
  );
}

/** The comments under one diff line: open editors and saved comments, in the order started. */
export function LineComments({
  sessionId,
  path,
  scopeKey,
  side,
  line,
}: {
  sessionId: string;
  path: string;
  scopeKey: string;
  side: DiffSide;
  line: number;
}) {
  const all = useDiffReviewStore((s) => sessionComments(s, sessionId));
  const here = all.filter(
    (c) =>
      c.path === path &&
      c.scopeKey === scopeKey &&
      c.range.endSide === side &&
      c.range.end === line,
  );
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

function CommentCard({ sessionId, comment }: { sessionId: string; comment: ReviewComment }) {
  const { setDraft, save, cancel, edit, remove } = useDiffReviewStore.getState();
  const label = rangeLabel(comment.range);
  const editing = comment.draft !== undefined;
  return (
    <div
      className="max-w-[46rem] rounded-lg border border-border bg-card text-xs text-foreground shadow-xs"
      data-testid="diff-comment"
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-3xs text-muted-foreground">
        <MessageSquare className="size-3" />
        <span className="flex-1 truncate">Comment on {label}</span>
        {!editing && (
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
 * now or queued behind a running turn like any message.
 */
export function ReviewBar({ session, scopeKey }: { session: Session; scopeKey: string }) {
  const client = useClient();
  const all = useDiffReviewStore((s) => sessionComments(s, session.id));
  const { remove, clear } = useDiffReviewStore.getState();
  const saved = savedComments(all);
  const unsaved = hasUnsavedEdit(all);
  const elsewhere = saved.filter((c) => c.scopeKey !== scopeKey).length;
  const send = useMutation({
    mutationFn: (comments: ReviewComment[]) =>
      sendToSession(client, session, { text: formatReviewMessage(comments) }, "queue"),
    onSuccess: (_d, comments) => {
      remove(
        session.id,
        comments.map((c) => c.id),
      );
      if (busyStatuses.includes(session.status))
        toast("Review queued", { description: "It's sent when the current turn ends." });
      else toast("Review sent to the agent");
    },
    onError: (e) => toast.error("Review not sent", { description: e.message }),
  });
  if (saved.length === 0) return null;
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-primary/[0.06] px-3 text-xs pointer-coarse:h-auto pointer-coarse:min-h-11"
      data-testid="diff-review-bar"
    >
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
          disabled={send.isPending}
          onClick={() => {
            if (window.confirm(`Discard ${plural(all.length, "draft comment")}?`))
              clear(session.id);
          }}
        >
          Discard
        </Button>
        <Button
          size="sm"
          className="text-xs"
          disabled={send.isPending || unsaved}
          title={
            unsaved
              ? "Save or cancel the comment you're editing first"
              : "Send every comment to the agent as one message"
          }
          onClick={() => send.mutate(saved)}
        >
          <SendHorizontal /> Send to agent
        </Button>
      </div>
    </div>
  );
}
