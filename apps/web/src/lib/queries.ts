import type { Project, Session, Snapshot } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useClient } from "./api";
import type { TranscriptState } from "./transcript/reducer";

export const snapshotKey = ["snapshot"] as const;

/** The app snapshot (projects, sessions, inbox, automations, settings), kept live by realtime. */
export function useSnapshot() {
  const client = useClient();
  return useQuery({
    queryKey: snapshotKey,
    queryFn: () => client.getSnapshot(),
    staleTime: Infinity,
  });
}

/** Select from the snapshot with a stable fallback. */
export function useSnapshotData<T>(select: (s: Snapshot) => T, fallback: T): T {
  const { data } = useSnapshot();
  return data ? select(data) : fallback;
}

export const setupKey = ["setup"] as const;

/**
 * Setup detection (installed? signed in?) for agent providers and tools (§14). The server
 * caches detection, so reading it is cheap; `staleTime` limits refetching from places that only
 * need a recent answer, such as the model picker.
 */
export function useSetupStatus(opts: { staleTime?: number } = {}) {
  const client = useClient();
  return useQuery({
    queryKey: setupKey,
    queryFn: () => client.getSetupStatus(),
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
  });
}

/** Run setup detection again now, past the server's cache, and share the answer. */
export function useRecheckSetup() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.getSetupStatus({ refresh: true }),
    onSuccess: (next) => queryClient.setQueryData(setupKey, next),
  });
}

export function useSession(sessionId: string | undefined): Session | undefined {
  return useSnapshotData((s) => s.sessions.find((x) => x.id === sessionId), undefined);
}

export function useProject(projectId: string | null | undefined): Project | undefined {
  return useSnapshotData((s) => s.projects.find((x) => x.id === projectId), undefined);
}

/** Load a session transcript into the live store and return it. */
export function useTranscript(sessionId: string | undefined): {
  transcript: TranscriptState | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => client.getSessionSnapshot(sessionId ?? ""),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });
  const resynced = useRef(false);
  useEffect(() => {
    if (!query.data) return;
    useTranscriptsStore.getState().load(query.data, { replace: resynced.current });
    resynced.current = false;
  }, [query.data]);
  // Live updates: watch the transcript from the snapshot's seq (§6).
  const seq = query.data?.seq;
  useEffect(() => {
    if (!sessionId || seq === undefined) return;
    return client.watchSession(sessionId, seq, (msg) => {
      if (msg.type === "transcript") useTranscriptsStore.getState().applyTranscript(msg);
      else {
        resynced.current = true;
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
    });
  }, [client, queryClient, sessionId, seq]);
  const transcript = useTranscriptsStore((s) => (sessionId ? s.byId[sessionId] : undefined));
  return { transcript, isLoading: query.isLoading, error: query.error };
}
