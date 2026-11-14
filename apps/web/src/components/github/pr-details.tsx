import type { GithubPrDetails } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ExternalLink, GitMerge, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/thread/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { useSession } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  CheckLabel,
  ChecksBadge,
  PrStateBadge,
  ReviewDecisionBadge,
} from "./github-bits";
import { PrFiles, PrFilesToggle, useOpenFiles } from "./pr-files";

function Section({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-5 items-center gap-2">
        <h3 className="flex-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Merge (squash) when the PR is open, not conflicting and checks did not fail. */
function MergeButton({ pr }: { pr: GithubPrDetails }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const merge = useMutation({
    mutationFn: () =>
      client.github.merge(pr.id, { method: "squash", sha: pr.headSha ?? undefined }),
    onSuccess: (r) => {
      if (r.merged) toast.success(`Merged #${pr.number}`);
      else toast.error("GitHub did not merge the pull request");
      void queryClient.invalidateQueries({ queryKey: ["github"] });
    },
    onError: (e) => toast.error("Couldn't merge", { description: e.message }),
  });
  if (pr.state !== "open") return null;
  const blocked =
    pr.mergeable === "conflicting" ||
    pr.checks.state === "failure" ||
    pr.checks.state === "pending";
  const why =
    pr.mergeable === "conflicting"
      ? "Has merge conflicts"
      : pr.checks.state === "failure"
        ? "Checks failed"
        : pr.checks.state === "pending"
          ? "Checks are still running"
          : "Squash and merge";
  return (
    <Button
      size="sm"
      onClick={() => merge.mutate()}
      disabled={blocked || merge.isPending}
      title={why}
    >
      <GitMerge /> {merge.isPending ? "Merging…" : "Squash and merge"}
    </Button>
  );
}

function LinkedSession({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId }}
      className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
    >
      Session: {session?.title ?? session?.purpose ?? sessionId.slice(0, 8)}
      <ArrowUpRight className="size-3" />
    </Link>
  );
}

/**
 * Live PR details (§9): state, checks, reviews, files changed (each with its diff), linked
 * session and merge.
 */
export function PrDetailsView({
  prId,
  showSession = true,
}: {
  prId: string;
  showSession?: boolean;
}) {
  const client = useClient();
  const files = useOpenFiles();
  const {
    data: pr,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["github", "pr", prId],
    queryFn: () => client.github.pr(prId),
    refetchInterval: 30_000,
  });
  if (isLoading)
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24" />
      </div>
    );
  if (error || !pr)
    return <p className="text-xs text-status-failed">{error?.message ?? "PR not found"}</p>;

  return (
    <div className="space-y-5" data-testid="pr-details">
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => platform.openExternal(pr.url)}
          className="group flex w-full items-start gap-2 text-left"
        >
          <span className="flex-1 text-[14px] font-medium group-hover:underline">
            {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
          </span>
          <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        </button>
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
          <PrStateBadge state={pr.state} />
          <ChecksBadge checks={pr.checks} />
          <ReviewDecisionBadge decision={pr.reviewDecision} />
          <span className="text-diff-add">+{pr.additions}</span>
          <span className="text-diff-del">−{pr.deletions}</span>
          <code className="truncate font-mono text-3xs">
            {pr.headBranch} → {pr.baseBranch}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MergeButton pr={pr} />
          {pr.mergeable === "conflicting" && (
            <span className="text-2xs text-status-failed">Merge conflicts</span>
          )}
          {showSession && pr.sessionId && <LinkedSession sessionId={pr.sessionId} />}
          {pr.linkedIssues.length > 0 && (
            <span className="text-2xs text-muted-foreground">
              Closes {pr.linkedIssues.map((n) => `#${n}`).join(", ")}
            </span>
          )}
        </div>
      </div>

      <Section title={`Checks · ${pr.checks.total}`}>
        {pr.checks.total === 0 ? (
          <p className="text-xs text-muted-foreground">No checks on the head commit.</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {pr.checks.checks.map((c) => (
              <button
                key={c.name}
                type="button"
                disabled={!c.url}
                onClick={() => c.url && platform.openExternal(c.url)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] enabled:hover:bg-accent/40"
              >
                <CheckIcon status={c.status} conclusion={c.conclusion} />
                <span className="flex-1 truncate font-mono text-[12px]">{c.name}</span>
                <CheckLabel status={c.status} conclusion={c.conclusion} />
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title={`Reviews · ${pr.reviews.length}`}>
        {pr.reviews.length === 0 ? (
          <p className="text-xs text-muted-foreground">No reviews yet.</p>
        ) : (
          <div className="space-y-2">
            {pr.reviews.map((r) => (
              <div key={r.id} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-2 text-2xs">
                  <MessageSquare className="size-3 text-muted-foreground" />
                  <span className="font-medium">{r.author ?? "someone"}</span>
                  <span
                    className={cn(
                      "text-muted-foreground",
                      r.state === "approved" && "text-status-done",
                      r.state === "changes_requested" && "text-status-failed",
                    )}
                  >
                    {r.state.replace("_", " ")}
                  </span>
                  {r.submittedAt && (
                    <span className="ml-auto text-muted-foreground">{ago(r.submittedAt)}</span>
                  )}
                </div>
                {r.body && <p className="mt-1 text-xs text-muted-foreground">{r.body}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`Files changed · ${pr.changedFiles}`}
        action={<PrFilesToggle pr={pr} open={files.open} onChange={files.setOpen} />}
      >
        <PrFiles pr={pr} open={files.open} onToggle={files.toggle} />
      </Section>

      {pr.body.trim() && (
        <Section title="Description">
          <Markdown className="text-[13px]">{pr.body}</Markdown>
        </Section>
      )}
    </div>
  );
}
