import type { GithubIssue, GithubPr, Project } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleDot, MessageSquare, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PrBadge, SectionLabel } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import type { GithubState } from "@/lib/api/feature-apis";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { ChecksBadge, GithubUnavailable, LabelChip, ReviewDecisionBadge } from "./github-bits";
import { PrDetailsView } from "./pr-details";
import { CheckRemoteButton, RemoteWarningBanner } from "./remote-check";

const STATES: GithubState[] = ["open", "closed", "all"];

function PrRow({ pr, onOpen }: { pr: GithubPr; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
      data-testid="github-pr-row"
    >
      <PrBadge pr={pr} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{pr.title}</span>
        <span className="block truncate text-3xs text-muted-foreground">
          {pr.author ?? "unknown"} · {pr.headBranch} · updated {ago(pr.updatedAt)}
        </span>
      </span>
      <ReviewDecisionBadge decision={pr.reviewDecision} />
      <ChecksBadge checks={pr.checks} />
      {pr.sessionId && (
        <span className="rounded-full border border-primary/30 px-1.5 py-px text-3xs text-primary">
          session
        </span>
      )}
    </button>
  );
}

function IssueRow({ issue }: { issue: GithubIssue }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2" data-testid="github-issue-row">
      <CircleDot
        className={cn(
          "size-3.5 shrink-0",
          issue.state === "open" ? "text-status-done" : "text-chart-4",
        )}
      />
      <button
        type="button"
        onClick={() => platform.openExternal(issue.url)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-[13px] hover:underline">
          {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
        </span>
        <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
          {issue.author ?? "unknown"} · updated {ago(issue.updatedAt)}
          {issue.comments > 0 && (
            <span className="inline-flex items-center gap-0.5">
              · <MessageSquare className="size-2.5" /> {issue.comments}
            </span>
          )}
        </span>
      </button>
      <span className="hidden max-w-56 flex-wrap justify-end gap-1 sm:flex">
        {issue.labels.slice(0, 4).map((l) => (
          <LabelChip key={l} name={l} />
        ))}
      </span>
      {issue.sessionIds[0] && (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: issue.sessionIds[0] }}
          className="inline-flex items-center gap-0.5 text-3xs text-primary hover:underline"
        >
          Session <ArrowUpRight className="size-3" />
        </Link>
      )}
    </div>
  );
}

function ListBox({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {children.length > 0 ? (
        children
      ) : (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

/** Project GitHub tab (§9): pull requests and issues with labels, status and checks. */
export function ProjectGithub({ project }: { project: Project }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [state, setState] = useState<GithubState>("open");
  const [openPr, setOpenPr] = useState<GithubPr | null>(null);
  const github = project.kind === "github";
  const prs = useQuery({
    queryKey: ["github", "prs", project.id, state],
    queryFn: () => client.github.prs(project.id, state),
    enabled: github,
  });
  const issues = useQuery({
    queryKey: ["github", "issues", project.id, state],
    queryFn: () => client.github.issues(project.id, state),
    enabled: github,
  });
  const sync = useMutation({
    mutationFn: () => client.github.sync(project.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["github"] }),
    onError: (e) => toast.error("Sync failed", { description: e.message }),
  });

  if (!github) {
    return <GithubUnavailable localOnly action={<CheckRemoteButton projectId={project.id} />} />;
  }
  const connection = prs.data?.connection ?? issues.data?.connection;
  if (connection && !connection.connected) return <GithubUnavailable connection={connection} />;
  const syncStatus = prs.data?.sync;

  return (
    <div className="space-y-6" data-testid="project-github">
      <RemoteWarningBanner project={project} />
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card/50 p-0.5 text-xs">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setState(s)}
              className={cn(
                "h-7 rounded-md px-2.5 capitalize text-muted-foreground hover:text-foreground",
                state === s && "bg-accent text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-3xs text-muted-foreground">
          {syncStatus?.lastError
            ? `Sync error: ${syncStatus.lastError}`
            : syncStatus?.lastSyncAt
              ? `Synced ${ago(syncStatus.lastSyncAt)}`
              : "Not synced yet"}
        </span>
        <Button size="xs" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={cn(sync.isPending && "animate-spin")} /> Sync
        </Button>
      </div>
      <section>
        <SectionLabel className="mb-2">Pull requests · {prs.data?.prs.length ?? 0}</SectionLabel>
        {prs.isLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : (
          <ListBox empty="No pull requests.">
            {(prs.data?.prs ?? []).map((pr) => (
              <PrRow key={pr.id} pr={pr} onOpen={() => setOpenPr(pr)} />
            ))}
          </ListBox>
        )}
      </section>
      <section>
        <SectionLabel className="mb-2">Issues · {issues.data?.issues.length ?? 0}</SectionLabel>
        {issues.isLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : (
          <ListBox empty="No issues.">
            {(issues.data?.issues ?? []).map((issue) => (
              <IssueRow key={issue.number} issue={issue} />
            ))}
          </ListBox>
        )}
      </section>
      <Dialog open={Boolean(openPr)} onOpenChange={(o) => !o && setOpenPr(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Pull request #{openPr?.number}</DialogTitle>
          </DialogHeader>
          {openPr && <PrDetailsView prId={openPr.id} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
