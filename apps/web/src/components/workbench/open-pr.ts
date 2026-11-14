import type { GitHubPrRef, QueuedMessage } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useClient } from "@/lib/api";
import {
  canAskForPullRequest,
  latestUserMessage,
  OPEN_PR_PROMPT,
  type PullRequestOffer,
  pullRequestOffer,
  pullRequestRequest,
} from "@/lib/pull-request";
import { useProject, useSession } from "@/lib/queries";
import { queueKey } from "@/lib/queue";
import { usePrRequestsStore } from "@/stores/pr-requests";
import { useTranscriptsStore } from "@/stores/transcripts";

/**
 * The session's pull request state for the Git bar, the Issue / PR tab and the Push toast:
 * whether to offer **Open PR**, a request already in progress ("PR requested"), and its open (or
 * draft) PR if it has one. Shares the session's GitHub query with the header badges, and its
 * queue and transcript with the thread view, so it costs no extra request there.
 */
export function usePullRequestOffer(sessionId: string): PullRequestOffer {
  const client = useClient();
  const session = useSession(sessionId);
  const project = useProject(session?.projectId);
  const { data } = useQuery({
    queryKey: ["github", "session", sessionId],
    queryFn: () => client.github.session(sessionId),
    enabled: project?.kind === "github" && session?.role === "agent",
    refetchInterval: 30_000,
  });
  const pr: GitHubPrRef | null = data?.pr
    ? { number: data.pr.number, url: data.pr.url, state: data.pr.state, title: data.pr.title }
    : (session?.pr ?? null);
  const connected = data?.connection.connected !== false;
  const { data: queue } = useQuery({
    queryKey: queueKey(sessionId),
    queryFn: () => client.queue.list(sessionId),
    enabled: connected && canAskForPullRequest(session, project, pr),
  });
  const latest = useTranscriptsStore(useShallow((s) => latestUserMessage(s.byId[sessionId])));
  const asked = usePrRequestsStore((s) => s.asked[sessionId]);
  return pullRequestOffer({ session, project, pr, connected, queue, latest, asked });
}

/**
 * Ask the session's agent to open a pull request: sent now when the session is idle, queued
 * behind the running turn otherwise. Does nothing while a request is already in progress, from
 * any of the controls, so pressing again never asks twice.
 */
export function useAskForPullRequest(sessionId: string): () => void {
  const client = useClient();
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: () => client.sendMessage(sessionId, { text: OPEN_PR_PROMPT }, "queue"),
    onSuccess: () => toast.success("Asked the agent to open a pull request"),
    onError: (e) => {
      usePrRequestsStore.getState().forget(sessionId);
      toast.error("Couldn't ask for a pull request", { description: e.message });
    },
  });
  return () => {
    const latest = latestUserMessage(useTranscriptsStore.getState().byId[sessionId]);
    const inProgress = pullRequestRequest({
      queue: queryClient.getQueryData<QueuedMessage[]>(queueKey(sessionId)),
      latest,
      asked: usePrRequestsStore.getState().asked[sessionId],
    });
    if (inProgress) return;
    usePrRequestsStore.getState().ask(sessionId, { after: latest?.id ?? null });
    send.mutate();
  };
}
