import { githubPrId } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, ExternalLink, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/bits";
import { GithubUnavailable, LabelChip } from "@/components/github/github-bits";
import { PrDetailsView } from "@/components/github/pr-details";
import { CheckRemoteButton } from "@/components/github/remote-check";
import { Markdown } from "@/components/thread/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { useProject, useSession } from "@/lib/queries";
import { useAskForPullRequest, usePullRequestOffer } from "./open-pr";
import { PrRequestedButton } from "./open-pr-controls";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function IssueSection({ projectId, number }: { projectId: string; number: number }) {
  const client = useClient();
  const { data: issue, isLoading } = useQuery({
    queryKey: ["github", "issue", projectId, number],
    queryFn: () => client.github.issue(projectId, number),
  });
  if (isLoading) return <Skeleton className="h-16" />;
  if (!issue) return null;
  return (
    <Section title="Issue">
      <button
        type="button"
        onClick={() => platform.openExternal(issue.url)}
        className="group flex w-full items-start gap-2 text-left"
      >
        <CircleDot
          className={
            issue.state === "open"
              ? "mt-0.5 size-4 shrink-0 text-status-done"
              : "mt-0.5 size-4 shrink-0 text-chart-4"
          }
        />
        <span className="flex-1 text-[14px] font-medium group-hover:underline">
          {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
        </span>
        <ExternalLink className="size-3.5 text-muted-foreground" />
      </button>
      <div className="flex flex-wrap gap-1.5">
        {issue.labels.map((l) => (
          <LabelChip key={l} name={l} />
        ))}
      </div>
      {issue.body && <Markdown className="text-[13px]">{issue.body}</Markdown>}
    </Section>
  );
}

/** The session's linked issue and pull request with live status (§9). */
export function GitHubPanel({ sessionId }: { sessionId: string }) {
  const client = useClient();
  const session = useSession(sessionId);
  const project = useProject(session?.projectId);
  const localOnly = project?.kind === "local";
  const { data, isLoading, error } = useQuery({
    queryKey: ["github", "session", sessionId],
    queryFn: () => client.github.session(sessionId),
    enabled: !localOnly,
    refetchInterval: 30_000,
  });
  const offer = usePullRequestOffer(sessionId);
  const askForPr = useAskForPullRequest(sessionId);

  if (project?.kind === "local") {
    return (
      <GithubUnavailable
        localOnly
        className="m-4"
        action={<CheckRemoteButton projectId={project.id} />}
      />
    );
  }
  if (isLoading)
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-20" />
      </div>
    );
  if (error) return <p className="p-4 text-xs text-status-failed">{error.message}</p>;
  if (data && !data.connection.connected)
    return <GithubUnavailable connection={data.connection} className="m-4" />;
  if (!data?.issue && !data?.pr) {
    return (
      <EmptyState
        icon={<GitPullRequest />}
        title="No issue or PR linked"
        className="h-full"
        action={
          offer.requested ? (
            <PrRequestedButton requested={offer.requested} size="sm" />
          ) : (
            offer.canAsk && (
              <Button size="sm" onClick={askForPr}>
                <GitPullRequest /> Open pull request
              </Button>
            )
          )
        }
      >
        {offer.requested === "queued"
          ? "The agent was asked to open a pull request. The request is queued behind the running turn, and the PR appears here once it's open."
          : offer.requested === "sent"
            ? "The agent was asked to open a pull request. It appears here once it's open."
            : "Sessions started from an issue link it here. When the work is ready, ask the agent to open a pull request and it appears here."}
      </EmptyState>
    );
  }
  return (
    <div className="h-full space-y-6 overflow-y-auto p-4 scroll-thin">
      {data.pr && (
        <Section title="Pull request">
          <PrDetailsView prId={githubPrId(data.pr.projectId, data.pr.number)} showSession={false} />
        </Section>
      )}
      {data.issue && session?.projectId && (
        <IssueSection projectId={session.projectId} number={data.issue.number} />
      )}
    </div>
  );
}
