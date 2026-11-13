import type {
  ConflictDecision,
  ConflictRecord,
  Snapshot,
  StartSessionRequestInit,
  StartSessionResponse,
  UserInputInit,
} from "@codeden/contracts";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { canSendDraft, draftInput } from "@/components/composer/composer-box";
import { type CodeDenClient, useClient } from "@/lib/api";
import {
  buildStartRequest,
  draftPurpose,
  LOCAL_CONFLICT_PREFIX,
  localConflict,
  type ResolvedDraft,
} from "@/lib/new-session";
import { snapshotKey } from "@/lib/queries";
import { getDraft, newSessionDraftKey, useComposerStore } from "@/stores/composer";
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

/** A conflict the server persisted (an inbox item), as opposed to one shown from the reply. */
const isPersisted = (record: ConflictRecord) => !record.id.startsWith(LOCAL_CONFLICT_PREFIX);

/**
 * The New session draft's first send: `POST /api/sessions` with the draft's options. On a start
 * the draft becomes the session (its first message shows at once, the URL moves to the session);
 * on a duplicate-work conflict the card shows above the composer; on a failure the draft stays.
 *
 * The composer stays usable under the card, so the card follows the draft: Wait, Join and Force
 * start the draft as it is when clicked (the message sent, if the composer was emptied), and
 * sending again checks the new draft and replaces the open conflict.
 */
export function useStartDraft(projectId: string, resolved: ResolvedDraft, workKey: string) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const draftKey = newSessionDraftKey(projectId);
  const draftText = useComposerStore((s) => getDraft(s, draftKey).text);
  const [conflict, setConflict] = useState<{
    record: ConflictRecord;
    request: StartSessionRequestInit;
  } | null>(null);
  /** The input the conflict's decision started with: the session's first message. */
  const decidedInput = useRef<UserInputInit | undefined>(undefined);

  /** The draft is now a session: forget it and show the session with its first message. */
  const becomeSession = (sessionId: string, input: UserInputInit | undefined, replace: boolean) => {
    if (input) useNewSessionStore.getState().setFirstMessage(sessionId, input);
    useComposerStore.getState().clear(draftKey);
    useNewSessionStore.getState().reset(projectId);
    setConflict(null);
    void navigate({ to: "/sessions/$sessionId", params: { sessionId }, replace });
  };
  const toProject = () => void navigate({ to: "/projects/$projectId", params: { projectId } });

  /** The start request for the draft as it is now; `sent` supplies the text if it was emptied. */
  const currentRequest = (sent: StartSessionRequestInit): StartSessionRequestInit => {
    const draft = getDraft(useComposerStore.getState(), draftKey);
    const input = canSendDraft(draft) ? draftInput(draft) : (sent.input ?? { text: "" });
    return buildStartRequest(projectId, input, resolved, workKey);
  };

  /** Close the conflict a new send replaces, so the inbox doesn't keep the stale request. */
  const dismissReplaced = async (record: ConflictRecord | undefined) => {
    if (!record || !isPersisted(record)) return;
    await client
      .resolveInbox(record.id, { status: "dismissed", note: "Replaced by a newer send" })
      .catch(() => undefined);
  };

  const start = useMutation({
    mutationFn: async (input: UserInputInit) => {
      const replaced = conflict?.record;
      const request = buildStartRequest(projectId, input, resolved, workKey);
      const result = await client.startSession(request);
      await dismissReplaced(replaced);
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
      void queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      switch (result.status) {
        case "conflict":
          setConflict(record ? { record, request } : null);
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
   * The card's decision, applied to the draft as it is now: a persisted conflict is resolved
   * with that request in place of the saved one, a local one retries the start with it.
   */
  const decide = async (decision: ConflictDecision): Promise<StartSessionResponse> => {
    if (!conflict) throw new Error("No conflict to resolve");
    const { record } = conflict;
    // Skip starts nothing, so the saved request is all it needs.
    const request =
      decision.resolution === "skip" ? conflict.request : currentRequest(conflict.request);
    decidedInput.current = request.input;
    if (!isPersisted(record)) return client.startSession({ ...request, conflict: decision });
    const replacement = decision.resolution === "skip" ? {} : { start: request };
    return (await client.resolveConflict(record.id, { ...decision, ...replacement })).result;
  };

  /**
   * After the conflict card's decision. The card shows its toast and opens the session in place
   * of the draft (it is rendered with `replace`), as a direct start does.
   */
  const onConflictResolved = (outcome: ConflictOutcome) => {
    const input = decidedInput.current;
    if (outcome.sessionId && ["started", "queued", "joined"].includes(outcome.status)) {
      const startedHere = outcome.status !== "joined";
      if (startedHere) void ensureInSnapshot(client, queryClient, outcome.sessionId);
      if (startedHere && input)
        useNewSessionStore.getState().setFirstMessage(outcome.sessionId, input);
      useComposerStore.getState().clear(draftKey);
      useNewSessionStore.getState().reset(projectId);
      setConflict(null);
      return;
    }
    // Skipped: nothing started, the draft stays for later.
    setConflict(null);
    toProject();
  };

  // The card names what Wait or Force would start: the draft's first line as it is now.
  const shown = conflict && {
    ...conflict.record,
    request: {
      ...conflict.record.request,
      purpose: draftPurpose(draftText) ?? conflict.record.request.purpose,
    },
  };

  return {
    send: (input: UserInputInit) => {
      if (!start.isPending) start.mutate(input);
    },
    sending: start.isPending,
    conflict: shown,
    decide,
    onConflictResolved,
  };
}
