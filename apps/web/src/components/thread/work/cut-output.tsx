import { type ToolOutputResponse, utf8ByteLength } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { WorkEntry } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";

/**
 * What the "output was cut" bar says. `shownBytes` is the transcript's copy, `totalBytes` all
 * the output the tool produced (when known), `full` the stored output once it was loaded.
 */
export function cutNotice(
  shownBytes: number,
  totalBytes: number | undefined,
  full: ToolOutputResponse | undefined,
  running: boolean,
): string {
  if (!full) {
    return totalBytes === undefined
      ? `Output cut · showing ${formatBytes(shownBytes)}`
      : `Showing ${formatBytes(shownBytes)} of ${formatBytes(totalBytes)}`;
  }
  if (totalBytes !== undefined && full.totalBytes < totalBytes) {
    return `${formatBytes(full.totalBytes)} of ${formatBytes(totalBytes)} was kept · the rest wasn't stored`;
  }
  return `${running ? "Output so far" : "Full output"} · ${formatBytes(full.totalBytes)}`;
}

export interface ShownOutput {
  /** The text to render: the transcript's copy, or the stored output once it was loaded. */
  text: string;
  /** The bar saying the output was cut, with Show full output; null when nothing was cut. */
  notice: ReactNode;
}

/**
 * A tool call's output as the transcript shows it. When its copy was cut (`truncated`), the
 * notice says how much is shown and loads what the server stored on demand (§6). A load while
 * the command still runs is a snapshot until "Back to live output".
 */
export function useShownOutput(sessionId: string, entry: WorkEntry): ShownOutput {
  const client = useClient();
  const load = useMutation({ mutationFn: () => client.getToolOutput(sessionId, entry.id) });
  const output = entry.kind === "tool_call" ? entry.output : undefined;
  const text = output?.text ?? "";
  if (!output?.truncated) return { text, notice: null };

  const running = entry.status === "in_progress";
  const full = load.data;
  const message = load.isError
    ? `Couldn't load the full output: ${load.error.message}`
    : cutNotice(utf8ByteLength(text), output.totalBytes, full, running);
  const action = full
    ? { label: running ? "Back to live output" : "Show less", run: () => load.reset() }
    : { label: load.isError ? "Try again" : "Show full output", run: () => load.mutate() };

  return {
    text: full ? full.text : text,
    notice: (
      <div className="flex min-w-0 items-center gap-2 font-sans text-2xs text-muted-foreground">
        <span
          role={load.isError ? "alert" : undefined}
          className={cn("min-w-0 flex-1 truncate", load.isError && "text-status-failed")}
          title={message}
        >
          {message}
        </span>
        <Button
          variant="link"
          size="xs"
          className="h-5 shrink-0 px-0 text-2xs"
          disabled={load.isPending}
          onClick={action.run}
        >
          {load.isPending ? (
            <>
              <Loader2 className="animate-spin" /> Loading…
            </>
          ) : (
            action.label
          )}
        </Button>
      </div>
    ),
  };
}
