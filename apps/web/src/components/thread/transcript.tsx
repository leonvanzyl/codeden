import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TranscriptState } from "@/lib/transcript/reducer";
import { buildTimeline, rowIndexOfItem, type TimelineRow } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";
import { TimelineRowView } from "./timeline-row";

const gapAfter = (row: TimelineRow, next: TimelineRow | undefined): number => {
  if (!next) return 0;
  if (row.type === "work" && next.type === "work") return 4;
  // An assistant message's Copy action hangs 20px below it; the next row would cover it.
  if (row.type === "user" || next.type === "user" || row.type === "assistant") return 24;
  if (next.type === "turn-end" || row.type === "turn-end") return 18;
  return 14;
};

/** How long a row opened from search stays highlighted. */
const FOCUS_HIGHLIGHT_MS = 2400;

/**
 * Virtualised transcript (§13). Sticks to the bottom while the user is there; scrolling up
 * releases it and shows a "jump to latest" button. With `focusItemId` (a search hit) it opens
 * at that item instead: centred, its work group expanded, briefly highlighted.
 */
export function Transcript({
  transcript,
  threadId,
  sessionId,
  focusItemId,
  footer,
  className,
  contentClassName,
}: {
  transcript: TranscriptState;
  threadId: string;
  sessionId: string;
  focusItemId?: string;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const rows = useMemo(() => buildTimeline(transcript, threadId), [transcript, threadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  // The row opened from search while it is highlighted, and the item it was opened for.
  const [focus, setFocus] = useState<{ index: number; key: string } | null>(null);
  const focusedItem = useRef<string | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "work" ? 30 : rows[i]?.type === "turn-end" ? 24 : 120),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
  });

  const scrollToEnd = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // Jump to the end on first render of a thread, unless it opens at a search hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per thread.
  useLayoutEffect(() => {
    if (focusItemId && rowIndexOfItem(rows, focusItemId) !== -1) return;
    stick.current = true;
    requestAnimationFrame(() => scrollToEnd());
    const t = setTimeout(() => scrollToEnd(), 120);
    return () => clearTimeout(t);
  }, [threadId]);

  // Open at the search hit once its row exists: stop following the end, then centre it.
  useLayoutEffect(() => {
    if (!focusItemId || focusedItem.current === focusItemId) return;
    const index = rowIndexOfItem(rows, focusItemId);
    const row = rows[index];
    if (!row) return;
    focusedItem.current = focusItemId;
    stick.current = false;
    setAtBottom(false);
    setFocus({ index, key: row.key });
  }, [focusItemId, rows]);

  useEffect(() => {
    if (!focus) return;
    virtualizer.scrollToIndex(focus.index, { align: "center" });
    // Rows measure (and the work group opens) after the first scroll: centre again.
    const again = setTimeout(
      () => virtualizer.scrollToIndex(focus.index, { align: "center" }),
      150,
    );
    const done = setTimeout(() => setFocus(null), FOCUS_HIGHLIGHT_MS);
    return () => {
      clearTimeout(again);
      clearTimeout(done);
    };
  }, [focus, virtualizer]);

  // Follow new content while pinned.
  const total = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow size changes only.
  useEffect(() => {
    if (stick.current && total > 0) scrollToEnd();
  }, [total]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        data-testid="transcript-scroll"
        className="h-full overflow-y-auto scroll-thin [scrollbar-gutter:stable]"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          stick.current = bottom;
          if (bottom !== atBottom) setAtBottom(bottom);
        }}
      >
        {/* Safety net: long words wrap, and nothing that still overflows can scroll sideways. */}
        <div
          className={cn(
            "mx-auto w-full max-w-[46rem] overflow-x-clip px-6 pt-6 pb-4 wrap-break-word",
            contentClassName,
          )}
        >
          <div style={{ height: total, position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              const focused = focus?.key === row.key;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{
                    transform: `translateY(${v.start}px)`,
                    paddingBottom: gapAfter(row, rows[v.index + 1]),
                  }}
                >
                  <div
                    data-focused={focused || undefined}
                    className={cn(
                      "rounded-xl transition-[background-color,box-shadow] duration-700",
                      focused && "bg-primary/[0.06] ring-1 ring-primary/30",
                    )}
                  >
                    <TimelineRowView
                      row={row}
                      sessionId={sessionId}
                      focusItemId={focused ? focusItemId : undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="xs"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border shadow-md"
          onClick={() => {
            stick.current = true;
            scrollToEnd(true);
          }}
        >
          <ArrowDown /> Latest
        </Button>
      )}
    </div>
  );
}
