import { MessageSquarePlus } from "lucide-react";
import { Fragment, type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pickedRange, pickerLines } from "@/lib/diff-line-picker";
import { type ReviewRange, rangeLabel } from "@/lib/diff-review";
import { cn } from "@/lib/utils";

/** Rows Page Up and Page Down move. */
const PAGE = 10;

const markerTone = {
  added: "text-diff-add",
  removed: "text-diff-del",
  unchanged: "text-muted-foreground",
} as const;

/**
 * The keyboard way into a comment on a file's diff, on the file's card: the diff view draws its
 * lines in a shadow root and offers its "+" only to a pointer. Comment opens a list of the
 * diff's lines, both sides. The arrow keys move, with Shift they pick several lines, Enter
 * comments on the picked lines (the editor opens under them, caret in it, as with the "+") and
 * Escape closes the list, back to Comment. The picked lines are highlighted in the diff too.
 */
export function DiffLinePicker({
  path,
  patch,
  onComment,
  onPreview,
  className,
}: {
  path: string;
  patch: string;
  onComment: (range: ReviewRange) => void;
  /** The lines picked so far, to highlight in the diff; null when the list closes unused. */
  onPreview: (range: ReviewRange | null) => void;
  className?: string;
}) {
  const lines = useMemo(() => pickerLines(patch), [patch]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState({ anchor: 0, active: 0 });
  const commented = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  if (lines.length === 0) return null;
  // The diff can refresh under an open list; stay within its rows.
  const last = lines.length - 1;
  const anchor = Math.min(picked.anchor, last);
  const active = Math.min(picked.active, last);
  const range = pickedRange(lines, anchor, active);
  const inRange = (i: number) => i >= Math.min(anchor, active) && i <= Math.max(anchor, active);

  const move = (to: number, extend: boolean) => {
    const next = Math.max(0, Math.min(last, to));
    const from = extend ? anchor : next;
    setPicked({ anchor: from, active: next });
    onPreview(pickedRange(lines, from, next));
    list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const comment = () => {
    if (!range) return;
    commented.current = true;
    setOpen(false);
    onComment(range);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      PageDown: active + PAGE,
      PageUp: active - PAGE,
      Home: 0,
      End: last,
    };
    const to = steps[e.key];
    if (to !== undefined) {
      e.preventDefault();
      move(to, e.shiftKey);
    } else if (e.key === "Enter") {
      e.preventDefault();
      comment();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          commented.current = false;
          setPicked({ anchor: 0, active: 0 });
          onPreview(pickedRange(lines, 0, 0));
        } else onPreview(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="xs"
          className={cn("data-[state=open]:opacity-100", className)}
          aria-label={`Comment on lines of ${path}`}
          title="Pick lines to comment on (arrow keys, then Enter)"
        >
          <MessageSquarePlus /> Comment
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(40rem,calc(100vw-2rem))] gap-1.5 p-1.5"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          list.current?.focus();
        }}
        // After a comment, its editor takes the focus, not Comment.
        onCloseAutoFocus={(e) => {
          if (commented.current) e.preventDefault();
        }}
      >
        <p id={`${id}-hint`} className="px-1 text-2xs text-muted-foreground">
          Arrow keys pick a line, with Shift several. Enter comments, Esc closes.
        </p>
        <div
          ref={list}
          role="listbox"
          tabIndex={0}
          aria-label={`Lines of ${path}`}
          aria-describedby={`${id}-hint`}
          aria-multiselectable
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onKeyDown}
          className="max-h-72 overflow-y-auto rounded-md border border-border py-0.5 font-mono text-2xs leading-5 outline-none scroll-thin focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {lines.map((l, i) => (
            <Fragment key={`${l.side}:${l.line}`}>
              {l.gapBefore && (
                <div aria-hidden className="px-2 text-muted-foreground select-none">
                  ⋯
                </div>
              )}
              <div
                id={`${id}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={inRange(i)}
                aria-label={l.label}
                data-index={i}
                // Keep the focus on the list, so the keys go on working after a click.
                onMouseDown={(e) => {
                  e.preventDefault();
                  move(i, e.shiftKey);
                }}
                className={cn(
                  "flex cursor-pointer gap-2 px-1.5",
                  inRange(i) && "bg-primary/15",
                  i === active && "outline-1 -outline-offset-1 outline-primary",
                )}
              >
                <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums select-none">
                  {l.oldLine ?? ""}
                </span>
                <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums select-none">
                  {l.newLine ?? ""}
                </span>
                <span className={cn("w-2 shrink-0 select-none", markerTone[l.kind])}>
                  {l.marker}
                </span>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
                  {l.text}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="xs" disabled={!range} onClick={comment}>
            {range ? `Comment on ${rangeLabel(range)}` : "Comment"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
