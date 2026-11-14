import type { FactoryRetryMode, GitHubPrRef } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hammer, RotateCcw } from "lucide-react";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/** Whether a stopped item's pull request is still open, so Retry sends it back to review. */
export function openPrOf(item: {
  pr: GitHubPrRef | null;
  ownedPr?: GitHubPrRef | null;
}): GitHubPrRef | null {
  if (item.ownedPr && (!item.pr || item.ownedPr.number === item.pr.number)) return item.ownedPr;
  return item.pr?.state === "open" || item.pr?.state === "draft" ? item.pr : null;
}

/**
 * Retry a stopped item (§10.1). With its pull request open, the default sends that PR back to a
 * fresh review (no new build, no second PR); `rebuild` starts over from the first step. Used on
 * the item page, the factory panel's columns and the Factory view, so a stopped item is never
 * more than a click from running again.
 */
export function RetryButton({
  projectId,
  itemId,
  pr,
  mode,
  size = "xs",
  variant = "ghost",
  className,
}: {
  projectId: string;
  itemId: string;
  /** The item's open PR, if any (`openPrOf`). */
  pr: GitHubPrRef | null;
  mode?: FactoryRetryMode;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const rebuild = mode === "rebuild" || !pr;
  const retry = useMutation({
    mutationFn: () => client.factory.retry(projectId, itemId, mode ? { mode } : {}),
    onSuccess: (item) => {
      toast.success(item.stage === "verifying" ? "Back in review" : "Queued again", {
        description:
          item.stage === "verifying" && item.pr
            ? `#${item.pr.number} gets a fresh review; no new build.`
            : "It starts over from the first step.",
      });
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e: Error) => toast.error("Couldn't retry", { description: e.message }),
  });
  const title = rebuild
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
