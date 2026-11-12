import type { McpServerTestRequest, McpServerTestResult, McpTestStage } from "@codeden/contracts";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A connection test in flight, its result, or why it could not run (runner offline, ...). */
export type McpTestState =
  | { status: "running" }
  | { status: "done"; result: McpServerTestResult }
  | { status: "error"; message: string };

/** Tool names shown before "show all". */
const COLLAPSED_TOOLS = 12;

const STAGE_LABEL: Record<McpTestStage, string> = {
  start: "Couldn't start or reach the server",
  connect: "Handshake failed",
  list_tools: "Couldn't list its tools",
};

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Runs connection tests. `run` replaces the previous result; `reset` drops it, and an answer
 * that arrives after a reset (or a newer run) is ignored.
 */
export function useMcpTest() {
  const client = useClient();
  const [state, setState] = useState<McpTestState | null>(null);
  const runId = useRef(0);
  const run = useCallback(
    async (req: McpServerTestRequest) => {
      const id = ++runId.current;
      setState({ status: "running" });
      try {
        const result = await client.agentConfig.testMcp(req);
        if (id === runId.current) setState({ status: "done", result });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (id === runId.current) setState({ status: "error", message });
      }
    },
    [client],
  );
  const reset = useCallback(() => {
    runId.current++;
    setState(null);
  }, []);
  return { state, run, reset };
}

/** The outcome of an MCP connection test (§12.4). */
export function McpTestResultView({
  state,
  onDismiss,
  className,
}: {
  state: McpTestState;
  onDismiss?: () => void;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  let icon: React.ReactNode;
  let headline: React.ReactNode;
  let body: React.ReactNode = null;

  if (state.status === "running") {
    icon = <Loader2 className="size-4 animate-spin text-muted-foreground" />;
    headline = <span className="text-muted-foreground">Connecting and listing tools…</span>;
  } else if (state.status === "error") {
    icon = <XCircle className="size-4 text-status-failed" />;
    headline = <span>The test didn't run</span>;
    body = <p className="text-2xs text-status-failed/90">{state.message}</p>;
  } else if (state.result.ok) {
    const r = state.result;
    const tools = showAll ? r.tools : r.tools.slice(0, COLLAPSED_TOOLS);
    const hidden = r.tools.length - tools.length;
    icon = <CheckCircle2 className="size-4 text-status-done" />;
    headline = (
      <span>
        Connected ·{" "}
        <span className="font-medium">{r.server.title || r.server.name || "server"}</span>
        {r.server.version && <span className="text-muted-foreground"> {r.server.version}</span>}
        {" · "}
        {r.toolCount === 1 ? "1 tool" : `${r.toolCount} tools`}
        <span className="text-muted-foreground"> · {duration(r.durationMs)}</span>
      </span>
    );
    body =
      r.toolCount === 0 ? (
        <p className="text-2xs text-muted-foreground">The server offers no tools.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {tools.map((t) => (
            <span
              key={t.name}
              title={t.description}
              className="rounded bg-muted px-1.5 py-px font-mono text-3xs text-muted-foreground"
            >
              {t.name}
            </span>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              className="px-1 text-3xs text-primary hover:underline"
              onClick={() => setShowAll(true)}
            >
              +{hidden} more
            </button>
          )}
          {showAll && r.toolCount > r.tools.length && (
            <span className="px-1 text-3xs text-muted-foreground">
              and {r.toolCount - r.tools.length} not listed
            </span>
          )}
        </div>
      );
  } else {
    const r = state.result;
    icon = <XCircle className="size-4 text-status-failed" />;
    headline = (
      <span>
        {r.timedOut ? "Timed out" : STAGE_LABEL[r.stage]}
        <span className="text-muted-foreground"> · {duration(r.durationMs)}</span>
      </span>
    );
    body = (
      <>
        <p className="break-words text-2xs text-status-failed/90">{r.error}</p>
        {r.stderrTail && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-3xs text-muted-foreground">
            {r.stderrTail}
          </pre>
        )}
      </>
    );
  }

  return (
    <div
      data-testid="mcp-test-result"
      className={cn(
        "space-y-1.5 rounded-lg border border-border bg-background/50 px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {icon}
        <div className="min-w-0 flex-1">{headline}</div>
        {onDismiss && state.status !== "running" && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss test result"
            onClick={onDismiss}
          >
            <X />
          </Button>
        )}
      </div>
      {body && <div className="space-y-1.5 pl-6">{body}</div>}
    </div>
  );
}
