import type { GitHubPrRef } from "@codeden/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useClient } from "@/lib/api";
import { canAskForPullRequest, isActivePr, OPEN_PR_PROMPT } from "@/lib/pull-request";
import { useProject, useSession } from "@/lib/queries";

/**
 * The session's pull request state for the Git bar and the Issue / PR tab: whether to offer
 * **Open PR**, and its open (or draft) PR if it has one. Shares the session's GitHub query with
 * the header badges, so it costs no extra request.
 */
export function usePullRequestOffer(sessionId: string): {
  canAsk: boolean;
  pr: GitHubPrRef | null;
} {
  const client = useClient();
  const session = useSession(sessionId);
  const project = useProject(session?.projectId);
  const { data } = useQuery({
    queryKey: ["github", "session", sessionId],
    queryFn: () => client.github.session(sessionId),
    enabled: project?.kind === "github" && session?.role === "agent",
    refetchInterval: 30_000,
  });
  const live: GitHubPrRef | null = data?.pr
    ? { number: data.pr.number, url: data.pr.url, state: data.pr.state, title: data.pr.title }
    : (session?.pr ?? null);
  return {
    canAsk: data?.connection.connected !== false && canAskForPullRequest(session, project, live),
    pr: isActivePr(live) ? live : null,
  };
}

/**
 * Ask the session's agent to open a pull request: sent now when the session is idle, queued
 * behind the running turn otherwise.
 */
export function useAskForPullRequest(sessionId: string) {
  const client = useClient();
  return useMutation({
    mutationFn: () => client.sendMessage(sessionId, { text: OPEN_PR_PROMPT }, "queue"),
    onSuccess: () => toast.success("Asked the agent to open a pull request"),
    onError: (e) => toast.error("Couldn't ask for a pull request", { description: e.message }),
  });
}
