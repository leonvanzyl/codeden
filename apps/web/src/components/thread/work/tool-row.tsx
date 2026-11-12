import { ChevronRight, CircleX, FileDiff, Loader2 } from "lucide-react";
import { useState } from "react";
import { duration } from "@/lib/format";
import type { WorkEntry } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { CommandOutput } from "./command-output";
import { useShownOutput } from "./cut-output";
import { entryIcon, entryLabel } from "./tool-meta";

function Details({ sessionId, entry }: { sessionId: string; entry: WorkEntry }) {
  const openTab = useLayoutStore((s) => s.openRightTab);
  const shown = useShownOutput(sessionId, entry);
  if (entry.kind === "reasoning") {
    return (
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap wrap-break-word text-muted-foreground italic">
        {entry.text || entry.summary}
      </p>
    );
  }
  switch (entry.toolKind) {
    case "command":
      return (
        <CommandOutput
          command={entry.command}
          output={shown.text}
          running={entry.status === "in_progress"}
          exitCode={entry.exitCode}
          cwd={entry.cwd}
          notice={shown.notice}
        />
      );
    case "file_edit":
      return (
        <div className="overflow-hidden rounded-lg border border-border">
          {entry.changes.map((c) => (
            <div
              key={c.path}
              className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-2xs last:border-0"
            >
              <span
                className={cn(
                  "w-3 text-center",
                  c.change === "add"
                    ? "text-diff-add"
                    : c.change === "delete"
                      ? "text-diff-del"
                      : "text-status-waiting",
                )}
              >
                {c.change === "add" ? "A" : c.change === "delete" ? "D" : "M"}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.path}</span>
              <span className="text-diff-add tabular-nums">+{c.additions ?? 0}</span>
              <span className="text-diff-del tabular-nums">−{c.deletions ?? 0}</span>
            </div>
          ))}
          <button
            type="button"
            onClick={() => openTab("diff")}
            className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground hover:text-foreground"
          >
            <FileDiff className="size-3.5" /> Open in diff panel
          </button>
        </div>
      );
    default: {
      const input = entry.input !== undefined ? JSON.stringify(entry.input, null, 2) : null;
      const output = shown.text;
      if (!input && !output && !shown.notice && !entry.error) return null;
      return (
        // Long unbroken tokens (ids, URLs, compact JSON) wrap anywhere so they never widen the row.
        <div className="space-y-1.5 rounded-lg border border-border bg-surface p-2.5 font-mono text-[11.5px] wrap-anywhere text-muted-foreground">
          {input && <pre className="whitespace-pre-wrap">{input}</pre>}
          {shown.notice}
          {output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-foreground/80 scroll-thin">
              {output}
            </pre>
          )}
          {entry.error && <p className="text-status-failed">{entry.error.message}</p>}
        </div>
      );
    }
  }
}

/**
 * Row columns: icon, verb, target, meta, spacer, then duration and chevron. Verb, target and
 * meta size to their text but can shrink to nothing (`minmax(0, auto)`). Space goes to the
 * shortest first, so short labels stay whole and only the long ones truncate with an ellipsis.
 * The spacer pushes the duration and chevron to the end, and those never shrink.
 */
const ROW_COLUMNS = "grid-cols-[auto_minmax(0,auto)_minmax(0,auto)_minmax(0,auto)_1fr_auto]";

interface ToolRowProps {
  sessionId: string;
  entry: WorkEntry;
  defaultOpen?: boolean;
}

/**
 * One tool call or reasoning step: a 26px row that expands into details. Its state (expanded,
 * loaded full output) belongs to one item, so a row handed another item (the "now running" row
 * of a collapsed work group) starts afresh.
 */
export function ToolRow(props: ToolRowProps) {
  return <ToolRowView key={`${props.sessionId}:${props.entry.id}`} {...props} />;
}

function ToolRowView({ sessionId, entry, defaultOpen = false }: ToolRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = entryIcon(entry);
  const { verb, target, meta } = entryLabel(entry);
  const running = entry.status === "in_progress";
  const failed = entry.status === "failed" || entry.status === "declined";
  const ms = entry.kind === "tool_call" ? entry.durationMs : undefined;
  const showDetails =
    open || (running && entry.kind === "tool_call" && entry.toolKind === "command");

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={showDetails}
        className={cn(
          "group/tool grid h-[26px] pointer-coarse:h-10 w-full min-w-0 items-center rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-accent/50",
          ROW_COLUMNS,
        )}
      >
        <span className="col-start-1 flex size-4 items-center justify-center text-muted-foreground">
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : failed ? (
            <CircleX className="size-3.5 text-status-failed" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </span>
        <span
          className={cn("col-start-2 ml-2 truncate text-muted-foreground", running && "text-shine")}
        >
          {verb}
        </span>
        {target && (
          <span
            title={target}
            className={cn(
              "col-start-3 ml-2 truncate font-mono text-[12px]",
              failed ? "text-status-failed/90" : "text-foreground/80",
            )}
          >
            {target}
          </span>
        )}
        {meta && (
          <span
            title={meta}
            className="col-start-4 ml-2 truncate text-2xs text-muted-foreground/70"
          >
            {meta}
          </span>
        )}
        <span className="col-start-6 flex items-center gap-1.5 pl-2">
          {ms !== undefined && !running && (
            <span className="text-3xs text-muted-foreground/60 tabular-nums">{duration(ms)}</span>
          )}
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 opacity-0 transition group-hover/tool:opacity-100",
              showDetails && "rotate-90 opacity-100",
            )}
          />
        </span>
      </button>
      {showDetails && (
        <div className="mt-1 mb-2 ml-6">
          <Details sessionId={sessionId} entry={entry} />
        </div>
      )}
    </div>
  );
}
