import { githubPrId, type InboxItem } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, GitMerge, GitPullRequest, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { ChecksBadge, ReviewDecisionBadge } from "@/components/github/github-bits";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { useLayoutStore } from "@/stores/layout";
import { RunFailedActions } from "./run-failed-actions";

const prIdOf = (item: InboxItem) =>
  item.projectId && item.pr ? githubPrId(item.projectId, item.pr.number) : null;

/** Live checks and review state of a `pr_review` item's PR. */
export function PrReviewStatus({ item }: { item: InboxItem }) {
  const client = useClient();
  const prId = prIdOf(item);
  const { data } = useQuery({
    queryKey: ["github", "pr", prId],
    queryFn: () => client.github.pr(prId ?? ""),
    enabled: Boolean(prId),
  });
  if (!data) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <ChecksBadge checks={data.checks} />
      <ReviewDecisionBadge decision={data.reviewDecision} />
      <span className="text-diff-add">+{data.additions}</span>
      <span className="text-diff-del">−{data.deletions}</span>
      <span>{data.files.length} files</span>
      {data.mergeable === "conflicting" && (
        <span className="text-status-failed">Merge conflicts</span>
      )}
    </div>
  );
}

/** The in-place answer for non-mirrored inbox items (§11.1); triage has its own card. */
export function InboxActions({ item }: { item: InboxItem }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openTab = useLayoutStore((s) => s.openRightTab);
  const fail = (e: Error) => toast.error("Couldn't update the item", { description: e.message });
  const dismiss = useMutation({
    mutationFn: () => client.resolveInbox(item.id, { status: "dismissed" }),
    onError: fail,
    onSuccess: () => toast.success("Dismissed"),
  });
  const merge = useMutation({
    mutationFn: async () => {
      const prId = prIdOf(item);
      if (!prId) throw new Error("This item has no pull request");
      const res = await client.github.merge(prId, { method: "squash" });
      if (!res.merged) throw new Error("GitHub did not merge the pull request");
      return res;
    },
    onError: (e) => toast.error("Couldn't merge", { description: e.message }),
    onSuccess: () => {
      toast.success(`Merged #${item.pr?.number}`);
      void queryClient.invalidateQueries({ queryKey: ["github"] });
    },
  });
  // Archiving again retries the worktree removal; the server resolves the item when it works.
  const removeAgain = useMutation({
    mutationFn: async () => {
      if (!item.sessionId) throw new Error("This item has no session");
      return client.archiveSession(item.sessionId);
    },
    onError: fail,
    onSuccess: (res) => {
      if (res.worktree.status === "removed") toast.success("Worktree removed");
      else {
        toast.error("Couldn't remove the worktree", {
          description: res.worktree.message ?? undefined,
        });
      }
    },
  });
  const busy = dismiss.isPending || merge.isPending || removeAgain.isPending;
  const dismissButton = (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => dismiss.mutate()}
      disabled={busy}
    >
      Dismiss
    </Button>
  );

  switch (item.kind) {
    case "pr_review": {
      const openPr = () => {
        if (item.sessionId) {
          openTab("github");
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: item.sessionId } });
        } else if (item.pr) platform.openExternal(item.pr.url);
      };
      return (
        <>
          <Button size="sm" onClick={() => merge.mutate()} disabled={busy || !prIdOf(item)}>
            <GitMerge /> {merge.isPending ? "Merging…" : "Merge"}
          </Button>
          <Button size="sm" variant="outline" onClick={openPr}>
            <GitPullRequest /> Open PR
          </Button>
          {item.pr && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => item.pr && platform.openExternal(item.pr.url)}
            >
              <ExternalLink /> GitHub
            </Button>
          )}
        </>
      );
    }
    case "run_failed":
      return <RunFailedActions item={item} busy={busy} dismissButton={dismissButton} />;
    case "cleanup_failed":
      return (
        <>
          <Button size="sm" onClick={() => removeAgain.mutate()} disabled={busy}>
            <RotateCcw /> {removeAgain.isPending ? "Removing…" : "Try again"}
          </Button>
          {dismissButton}
        </>
      );
    case "automation_result":
    case "message":
      return dismissButton;
    default:
      return null;
  }
}
