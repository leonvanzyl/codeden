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
 * What the "output was cut" bar says. `shownBytes` is the transcript's copy and `liveBytes` all
 * the output the tool has produced so far (when known). Once `full` (the stored copy) is loaded,
 * it is described with the server's own figures from that moment: output lost only when the
 * server says its copy is cut, and "more has arrived since" when the tool kept writing after.
 */
export function cutNotice(
  shownBytes: number,
  liveBytes: number | undefined,
  full: ToolOutputResponse | undefined,
  running: boolean,
): string {
  if (!full) {
    return liveBytes === undefined
      ? `Output cut · showing ${formatBytes(shownBytes)}`
      : `Showing ${formatBytes(shownBytes)} of ${formatBytes(liveBytes)}`;
  }
  const newer = liveBytes !== undefined && liveBytes > full.outputBytes;
  const loaded = formatBytes(full.totalBytes);
  const base = full.truncated
    ? `${loaded} of ${formatBytes(full.outputBytes)} was kept · the rest wasn't stored`
    : newer
      ? `Output when loaded · ${loaded}`
      : `${running ? "Output so far" : "Full output"} · ${loaded}`;
  return newer ? `${base} · more has arrived since` : base;
}

export interface ShownOutput {
  /** The text to render: the transcript's copy, or the stored output once it was loaded. */
  text: string;
  /** The bar saying the output was cut, with Show full output; null when nothing was cut. */
  notice: ReactNode;
}

interface Target {
  sessionId: string;
  itemId: string;
}

/**
 * A tool call's output as the transcript shows it. When its copy was cut (`truncated`), the
 * notice says how much is shown and loads what the server stored on demand (§6). A load belongs
 * to the item it was made for: a result or a request still in flight for another item is never
 * shown. A load while the command still runs is a snapshot until "Back to live output".
 */
export function useShownOutput(sessionId: string, entry: WorkEntry): ShownOutput {
  const client = useClient();
  const load = useMutation({
    mutationFn: (t: Target) => client.getToolOutput(t.sessionId, t.itemId),
  });
  const output = entry.kind === "tool_call" ? entry.output : undefined;
  const text = output?.text ?? "";
  if (!output?.truncated) return { text, notice: null };

  const mine = load.variables?.sessionId === sessionId && load.variables.itemId === entry.id;
  const full = mine && load.data?.itemId === entry.id ? load.data : undefined;
  const pending = mine && load.isPending;
  const failed = mine && load.isError;
  const running = entry.status === "in_progress";
  const message = failed
    ? `Couldn't load the full output: ${load.error?.message ?? "unknown error"}`
    : cutNotice(utf8ByteLength(text), output.totalBytes, full, running);
  const action = full
    ? { label: running ? "Back to live output" : "Show less", run: () => load.reset() }
    : {
        label: failed ? "Try again" : "Show full output",
        run: () => load.mutate({ sessionId, itemId: entry.id }),
      };

  return {
    text: full ? full.text : text,
    notice: (
      <div className="flex min-w-0 items-center gap-2 font-sans text-2xs text-muted-foreground">
        <span
          role={failed ? "alert" : undefined}
          className={cn("min-w-0 flex-1 truncate", failed && "text-status-failed")}
          title={message}
        >
          {message}
        </span>
        <Button
          variant="link"
          size="xs"
          className="h-5 shrink-0 px-0 text-2xs"
          disabled={pending}
          onClick={action.run}
        >
          {pending ? (
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
