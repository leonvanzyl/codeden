import type { ClaudeSdkStatus } from "@codeden/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, RotateCw, X } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

const KEY = ["setup", "claude-sdk"] as const;

/**
 * Claude Code support (§14): the Claude Agent SDK, installed from npm into `<home>/deps` the
 * first time it is needed. Polls while an install runs so the row shows live progress.
 */
export function useClaudeSdkStatus(enabled: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: KEY,
    queryFn: () => client.getClaudeSdkStatus(),
    enabled,
    refetchInterval: (query) => (query.state.data?.state === "installing" ? 700 : false),
  });
}

/** Start (or join) the install; the status query picks up the progress. */
export function useInstallClaudeSdk() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useCallback(async (): Promise<ClaudeSdkStatus | null> => {
    try {
      const status = await client.installClaudeSdk();
      queryClient.setQueryData<ClaudeSdkStatus>(KEY, status);
      return status;
    } catch (error) {
      toast.error("Couldn't start the install", { description: (error as Error).message });
      return null;
    }
  }, [client, queryClient]);
}

function message(status: ClaudeSdkStatus | undefined): string {
  if (!status) return "Checking…";
  switch (status.state) {
    case "ready":
      return status.source === "workspace"
        ? `Agent SDK ${status.version} (development checkout)`
        : `Agent SDK ${status.version} installed`;
    case "installing":
      return status.progress ?? "Installing…";
    case "failed":
      return status.error ?? "The install failed";
    default:
      return "Installs the Claude Agent SDK from npm (about 5 MB) when you continue";
  }
}

/** The checklist row under Claude Code. */
export function ClaudeSupportRow() {
  const { data } = useClaudeSdkStatus(true);
  const install = useInstallClaudeSdk();
  const state = data?.state;
  const base =
    "flex size-6 shrink-0 items-center justify-center rounded-full transition-all duration-300";
  return (
    <div className="flex items-center gap-3 px-4 py-3 pl-8" data-check="claude-sdk">
      {state === "ready" ? (
        <span className={cn(base, "bg-status-done/15 text-status-done")}>
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      ) : state === "failed" ? (
        <span className={cn(base, "bg-status-failed/12 text-status-failed")}>
          <X className="size-3.5" strokeWidth={3} />
        </span>
      ) : state === "installing" || !data ? (
        <span className={cn(base, "border border-border")}>
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        </span>
      ) : (
        <span className={cn(base, "border border-border text-muted-foreground")}>
          <Download className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">Claude Code support</div>
        {/* Wraps rather than truncates: on a phone a cut-off line hides what will happen. */}
        <div
          className={cn(
            "text-2xs break-words",
            state === "failed" ? "text-status-failed/90" : "text-muted-foreground",
          )}
          title={message(data)}
          data-testid="claude-sdk-message"
        >
          {message(data)}
        </div>
      </div>
      {state === "failed" && (
        <Button size="sm" variant="outline" onClick={() => void install()}>
          <RotateCw /> Retry
        </Button>
      )}
      {state === "missing" && (
        <Button size="xs" variant="ghost" onClick={() => void install()}>
          <Download /> Install now
        </Button>
      )}
    </div>
  );
}
