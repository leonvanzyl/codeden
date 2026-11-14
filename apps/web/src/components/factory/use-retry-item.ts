import type { FactoryRetryMode } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/**
 * Retry a stopped factory item (§10.1): the one mutation behind every Retry button (the item
 * page, the panel's columns, the Factory view's Needs you cards and its repair bay). With its
 * pull request open the server sends that PR back to a fresh review; otherwise, or with
 * `mode: "rebuild"`, the work starts over from the first step.
 */
export function useRetryItem(projectId: string, itemId: string, mode?: FactoryRetryMode) {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.factory.retry(projectId, itemId, mode ? { mode } : {}),
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
}
