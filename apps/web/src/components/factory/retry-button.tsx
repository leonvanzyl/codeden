import { type FactoryRetryMode, type StoppedItem, stoppedRetry } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hammer, RotateCcw } from "lucide-react";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/**
 * Retry a stopped item (§10.1). Whether it shows, and what it does, come from the shared rule
 * (`stoppedRetry`): with its pull request open, Retry sends that PR back to a fresh review (no new
 * build, no second PR); otherwise, or as `mode="rebuild"`, the work starts over from the first
 * step. Renders nothing for work that hasn't stopped.
 */
export function RetryButton({
  projectId,
  item,
  mode,
  size = "xs",
  variant = "ghost",
  className,
}: {
  projectId: string;
  /** A `FactoryItem` or a panel `FactoryWorkItem`. */
  item: StoppedItem & { id: string };
  mode?: FactoryRetryMode;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => client.factory.retry(projectId, item.id, mode ? { mode } : {}),
    onSuccess: (next) => {
      toast.success(next.stage === "verifying" ? "Back in review" : "Queued again", {
        description:
          next.stage === "verifying" && next.pr
            ? `#${next.pr.number} gets a fresh review; no new build.`
            : "It starts over from the first step.",
      });
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e: Error) => toast.error("Couldn't retry", { description: e.message }),
  });
  const can = stoppedRetry(item);
  if (!can) return null;
  const pr = can.pr;
  const rebuild = (mode ?? can.mode) === "rebuild";
  const title =
    rebuild || !pr
      ? `Run it again from the first step${pr ? `, replacing #${pr.number}` : ""}`
      : `Send #${pr.number} back to a fresh review of its latest commits (no new build)`;
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      title={title}
      disabled={retry.isPending}
      data-testid={mode === "rebuild" ? "factory-rebuild" : "factory-retry"}
      onClick={(e) => {
        // Inside a link or a card: retry without opening the item.
        e.preventDefault();
        e.stopPropagation();
        retry.mutate();
      }}
    >
      {mode === "rebuild" ? <Hammer /> : <RotateCcw />}
      {mode === "rebuild" ? "Rebuild" : "Retry"}
    </Button>
  );
}
