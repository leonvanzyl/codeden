import type { ItemOf } from "@codeden/contracts";
import { ArrowUpRight, Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { subagentStatsParts, subagentStatsTitle } from "@/lib/format";
import { threadItems } from "@/lib/transcript/reducer";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useTranscriptsStore } from "@/stores/transcripts";
import { entryLabel } from "../work/tool-meta";

/** Latest activity line of the child thread, for the live status. */
function useChildActivity(
  sessionId: string,
  threadId: string,
): { line: string | null; steps: number } {
  return useTranscriptsStore(
    useShallow((s) => {
      const t = s.byId[sessionId];
      if (!t) return { line: null, steps: 0 };
      const items = threadItems(t, threadId);
      const last = items.at(-1)?.item;
      let line: string | null = null;
      if (last?.kind === "assistant_message") line = last.text.split(/(?<=[.!?])\s/)[0] ?? null;
      else if (last?.kind === "tool_call" || last?.kind === "reasoning") {
        const l = entryLabel(last);
        line = [l.verb, l.target].filter(Boolean).join(" ");
      }
      return { line, steps: items.length };
    }),
  );
}

/**
 * Compact subagent card with live status and, once finished, the tokens, tool calls and
 * duration its provider reported; opens the child thread in the right panel (§7.3).
 */
export function SubagentCard({ item, sessionId }: { item: ItemOf<"subagent">; sessionId: string }) {
  const openChild = useLayoutStore((s) => s.openChildThread);
  const { line, steps } = useChildActivity(sessionId, item.childThreadId);
  const running = item.status === "in_progress";
  const failed = item.status === "failed";
  // What the finished run used, when the provider reports it (§7.3).
  const stats = running ? [] : subagentStatsParts(item.stats);

  return (
    <button
      type="button"
      onClick={() => openChild(sessionId, item.childThreadId)}
      className="group flex w-full items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-card/80"
    >
      <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-chart-4/12 text-chart-4">
        <Bot className="size-4" />
        {running && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-status-running" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium">
            {item.description ?? "Subagent"}
          </span>
          {item.agentType && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-px font-mono text-3xs text-muted-foreground">
              {item.agentType}
            </span>
          )}
        </span>
        <span
          className={cn(
            "mt-1 flex items-center gap-1.5 text-2xs",
            running ? "text-muted-foreground" : "text-muted-foreground/80",
          )}
        >
          {running ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-status-running" />
          ) : failed ? (
            <XCircle className="size-3 shrink-0 text-status-failed" />
          ) : (
            <CheckCircle2 className="size-3 shrink-0 text-status-done" />
          )}
          <span className={cn("truncate", running && "text-shine")}>
            {running ? (line ?? "Starting…") : (item.summary ?? (failed ? "Failed" : "Finished"))}
          </span>
          {stats.length > 0 ? (
            <span
              className="shrink-0 text-muted-foreground/60 tabular-nums"
              title={subagentStatsTitle(item.stats)}
            >
              · {stats.join(" · ")}
            </span>
          ) : (
            steps > 0 && (
              <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                · {steps} steps
              </span>
            )
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 self-center text-2xs text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100">
        Open <ArrowUpRight className="size-3.5" />
      </span>
    </button>
  );
}
