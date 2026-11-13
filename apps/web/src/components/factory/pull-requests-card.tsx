import type { FactoryPrEntry } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import { StatusDot } from "@/components/common/status-dot";
import { cn } from "@/lib/utils";
import { PR_STATE_LABEL } from "./meta";

/**
 * The factory's pull requests (§10.1, Merge): the merge queue in the order it merges, then the
 * other PRs the loop owns until they merge or close, then today's merges. Each says where it
 * stands: waiting for CI, queued, updating, rebasing, rebuilding, merged, waiting for you.
 */
export function PullRequestsCard({
  projectId,
  pullRequests,
}: {
  projectId: string;
  pullRequests: FactoryPrEntry[];
}) {
  const queued = pullRequests.filter((p) => p.queuePosition !== null).length;
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-surface"
      data-testid="factory-pull-requests"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-2xs font-medium text-muted-foreground">
        <GitPullRequest className="size-3.5" />
        Pull requests
        <span
          className="font-normal text-muted-foreground/80"
          title="With auto-merge on, the factory merges one pull request at a time, oldest approved first, bringing each up to date with the default branch first."
        >
          · merge queue {queued > 0 ? `${queued} waiting` : "empty"}
        </span>
        <span className="ml-auto tabular-nums">{pullRequests.length}</span>
      </div>
      {pullRequests.length === 0 ? (
        <p className="px-2 py-3 text-center text-3xs text-muted-foreground/70">
          No open factory pull requests
        </p>
      ) : (
        <ol className="space-y-0.5 p-1.5">
          {pullRequests.map((p) => (
            <PrRow key={`${p.itemId}:${p.pr.number}`} projectId={projectId} entry={p} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PrRow({ projectId, entry }: { projectId: string; entry: FactoryPrEntry }) {
  const state = PR_STATE_LABEL[entry.state];
  return (
    <li data-testid="factory-pr" data-state={entry.state}>
      <Link
        to="/projects/$projectId/factory/$itemId"
        params={{ projectId, itemId: entry.itemId }}
        className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors hover:bg-accent/60"
      >
        <span
          className={cn(
            "mt-px inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-md text-3xs tabular-nums",
            entry.queuePosition !== null
              ? "bg-status-waiting/15 font-medium text-status-waiting"
              : "text-muted-foreground/60",
          )}
          title={
            entry.queuePosition !== null
              ? `Number ${entry.queuePosition} in the merge queue`
              : "Not in the merge queue"
          }
          data-testid="factory-pr-position"
        >
          {entry.queuePosition ?? "·"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              #{entry.pr.number}
            </span>
            <span className="truncate" title={entry.title}>
              {entry.title}
            </span>
          </span>
          {entry.note && (
            <span className="block truncate text-3xs text-muted-foreground/80" title={entry.note}>
              {entry.note}
            </span>
          )}
        </span>
        <span
          className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-3xs text-muted-foreground"
          title={state.help}
        >
          <StatusDot tone={state.tone} className="size-1.5 [&>span]:size-1.5" />
          {state.label}
        </span>
      </Link>
    </li>
  );
}
