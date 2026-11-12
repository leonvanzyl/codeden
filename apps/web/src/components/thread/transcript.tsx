import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TranscriptState } from "@/lib/transcript/reducer";
import { buildTimeline, type TimelineRow } from "@/lib/transcript/timeline";
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

/**
 * Virtualised transcript (§13). Sticks to the bottom while the user is there; scrolling up
 * releases it and shows a "jump to latest" button.
 */
export function Transcript({
  transcript,
  threadId,
  sessionId,
  footer,
  className,
  contentClassName,
}: {
  transcript: TranscriptState;
  threadId: string;
  sessionId: string;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const rows = useMemo(() => buildTimeline(transcript, threadId), [transcript, threadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

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

  // Jump to the end on first render of a thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per thread.
  useLayoutEffect(() => {
    stick.current = true;
    requestAnimationFrame(() => scrollToEnd());
    const t = setTimeout(() => scrollToEnd(), 120);
    return () => clearTimeout(t);
  }, [threadId]);

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
                  <TimelineRowView row={row} sessionId={sessionId} />
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
