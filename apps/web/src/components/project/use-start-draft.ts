import type {
  ConflictRecord,
  Snapshot,
  StartSessionRequestInit,
  UserInputInit,
} from "@codeden/contracts";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { type CodeDenClient, useClient } from "@/lib/api";
import { buildStartRequest, localConflict, type ResolvedDraft } from "@/lib/new-session";
import { snapshotKey } from "@/lib/queries";
import { newSessionDraftKey, useComposerStore } from "@/stores/composer";
import { useNewSessionStore } from "@/stores/new-session";
import type { ConflictOutcome } from "./conflict-card";

/**
 * Put a session that was just started into the snapshot if the realtime event hasn't brought it
 * yet, so its view opens on it rather than on "Session not found".
 */
async function ensureInSnapshot(client: CodeDenClient, queryClient: QueryClient, id: string) {
  const has = (s: Snapshot | undefined) => Boolean(s?.sessions.some((x) => x.id === id));
  if (has(queryClient.getQueryData<Snapshot>(snapshotKey))) return;
  try {
    const { session } = await client.getSessionDetail(id);
    queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
      s && !has(s) ? { ...s, sessions: [...s.sessions, session] } : s,
    );
  } catch {
    // The realtime event brings it; the view shows the first message meanwhile.
  }
}

/**
 * The New session draft's first send: `POST /api/sessions` with the draft's options. On a start
 * the draft becomes the session (its first message shows at once, the URL moves to the session);
 * on a duplicate-work conflict the card shows above the composer; on a failure the draft stays.
 */
export function useStartDraft(projectId: string, resolved: ResolvedDraft, workKey: string) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [conflict, setConflict] = useState<{
    record: ConflictRecord;
    request: StartSessionRequestInit;
  } | null>(null);

  /** The draft is now a session: forget it and show the session with its first message. */
  const becomeSession = (sessionId: string, input: UserInputInit | undefined, replace: boolean) => {
    if (input) useNewSessionStore.getState().setFirstMessage(sessionId, input);
    useComposerStore.getState().clear(newSessionDraftKey(projectId));
    useNewSessionStore.getState().reset(projectId);
    setConflict(null);
    void navigate({ to: "/sessions/$sessionId", params: { sessionId }, replace });
  };
  const toProject = () => void navigate({ to: "/projects/$projectId", params: { projectId } });

  const start = useMutation({
    mutationFn: async (input: UserInputInit) => {
      const request = buildStartRequest(projectId, input, resolved, workKey);
      const result = await client.startSession(request);
      if (result.status === "conflict") {
        // The server persisted the conflict (409 with `conflictId`); show that record.
        const persisted = result.conflictId
          ? (await client.listConflicts({ projectId })).find((c) => c.id === result.conflictId)
          : undefined;
        return { request, result, record: persisted ?? localConflict(request, result) };
      }
      if (result.status === "started" || result.status === "queued") {
        await ensureInSnapshot(client, queryClient, result.sessionId);
      }
      return { request, result, record: null };
    },
    onSuccess: ({ request, result, record }) => {
      switch (result.status) {
        case "conflict":
          if (record) setConflict({ record, request });
          return;
        case "skipped":
          toProject();
          return;
        case "queued":
          toast("Queued behind running work");
          becomeSession(result.sessionId, request.input, true);
          return;
        case "started":
          becomeSession(result.sessionId, request.input, true);
          return;
        case "joined":
          becomeSession(result.sessionId, undefined, true);
          return;
      }
    },
    onError: (e) => toast.error("Couldn't start the session", { description: e.message }),
  });

  /**
   * After the conflict card's decision. The card shows its toast and opens the session in place
   * of the draft (it is rendered with `replace`), as a direct start does.
   */
  const onConflictResolved = (outcome: ConflictOutcome) => {
    const input = conflict?.request.input;
    if (outcome.sessionId && ["started", "queued", "joined"].includes(outcome.status)) {
      const startedHere = outcome.status !== "joined";
      if (startedHere) void ensureInSnapshot(client, queryClient, outcome.sessionId);
      if (startedHere && input)
        useNewSessionStore.getState().setFirstMessage(outcome.sessionId, input);
      useComposerStore.getState().clear(newSessionDraftKey(projectId));
      useNewSessionStore.getState().reset(projectId);
      setConflict(null);
      return;
    }
    // Skipped: nothing started, the draft stays for later.
    setConflict(null);
    toProject();
  };

  return {
    send: (input: UserInputInit) => {
      if (!start.isPending) start.mutate(input);
    },
    sending: start.isPending,
    conflict: conflict?.record ?? null,
    onConflictResolved,
  };
}
