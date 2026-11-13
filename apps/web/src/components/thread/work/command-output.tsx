import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Live command output: monospace, capped height, pinned to the bottom while streaming.
 * `notice` (output was cut, see `useShownOutput`) sits between the command and its output.
 */
export function CommandOutput({
  command,
  output,
  running,
  exitCode,
  cwd,
  notice,
}: {
  command: string;
  output: string;
  running: boolean;
  exitCode?: number | null;
  cwd?: string;
  notice?: ReactNode;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever new output arrives.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-2xs">
        <span className="text-primary/80 select-none">$</span>
        <span className="min-w-0 flex-1 truncate text-foreground/90" title={command}>
          {command}
        </span>
        {cwd && <span className="hidden truncate text-muted-foreground/70 sm:inline">{cwd}</span>}
        {!running && exitCode !== undefined && exitCode !== null && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-px text-3xs font-medium",
              exitCode === 0
                ? "bg-status-done/12 text-status-done"
                : "bg-status-failed/12 text-status-failed",
            )}
          >
            exit {exitCode}
          </span>
        )}
      </div>
      {notice && <div className="border-b border-border bg-muted/30 px-3 py-0.5">{notice}</div>}
      {output ? (
        <pre
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
          className="max-h-64 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap wrap-anywhere text-muted-foreground scroll-thin"
        >
          {output}
          {running && (
            <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-foreground/60" />
          )}
        </pre>
      ) : (
        <div className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground/60">
          {running ? "Waiting for output…" : "No output"}
        </div>
      )}
    </div>
  );
}
