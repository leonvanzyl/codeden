import type { Project, ProjectCheck, Session, Snapshot } from "@codeden/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useTranscriptsStore } from "@/stores/transcripts";
import { type CodeDenClient, useClient } from "./api";
import { sessionLoader } from "./session-batch";
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

/**
 * Select from the snapshot with a stable fallback. The fallback stands in until the snapshot
 * loads, so a view that would say "nothing here" or "none" from an empty fallback reads
 * `useSnapshot().data` instead and shows a loading state while it is undefined (#400).
 */
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

/**
 * The query holding a session the snapshot doesn't carry, fetched by id: the session, or null
 * when the server has none by that id.
 */
export const sessionRecordKey = (sessionId: string) => ["session-record", sessionId] as const;

/**
 * The query of one session fetched by id. Fetched once and kept (realtime keeps it current),
 * through the client's loader, so the lookups a render starts share one request.
 */
function sessionRecordQuery(client: CodeDenClient, sessionId: string, enabled: boolean) {
  return {
    queryKey: sessionRecordKey(sessionId),
    queryFn: () => sessionLoader(client)(sessionId),
    enabled,
    staleTime: Infinity,
    retry: false,
  };
}

/**
 * A session by id, from the snapshot, or fetched when the snapshot doesn't carry it: one
 * archived before its recent window, opened from a link, a search hit or a factory item (§6).
 * Realtime keeps the fetched copy current (`syncSessionQueries`). `loading` while fetching.
 */
export function useSessionLookup(sessionId: string | undefined): {
  session: Session | undefined;
  loading: boolean;
} {
  const client = useClient();
  const { data: snapshot } = useSnapshot();
  const listed = sessionId ? snapshot?.sessions.find((x) => x.id === sessionId) : undefined;
  const fetch = Boolean(sessionId && snapshot && !listed);
  const record = useQuery(sessionRecordQuery(client, sessionId ?? "", fetch));
  return {
    session: listed ?? (fetch ? (record.data ?? undefined) : undefined),
    loading: Boolean(sessionId) && (!snapshot || (fetch && record.isLoading)),
  };
}

/** The sessions the lookups found (a combine for `useQueries`, so it stays stable). */
function foundSessions(results: { data?: Session | null }[]): Session[] {
  return results.flatMap((r) => (r.data ? [r.data] : []));
}

/**
 * Several sessions by id, found as `useSessionLookup` finds one: from the snapshot, else
 * fetched, all of them in one request, and kept current the same way. Ids that don't exist
 * are left out. The map stays the same while what it holds doesn't change.
 */
export function useSessionLookups(sessionIds: readonly string[]): ReadonlyMap<string, Session> {
  const client = useClient();
  const { data: snapshot } = useSnapshot();
  // The ids as one value, so a new array with the same ids changes nothing.
  const key = [...new Set(sessionIds)].sort().join("\n");
  const missing = useMemo(() => {
    if (!snapshot || !key) return [];
    const listed = new Set(snapshot.sessions.map((s) => s.id));
    return key.split("\n").filter((id) => !listed.has(id));
  }, [snapshot, key]);
  const fetched = useQueries({
    queries: missing.map((id) => sessionRecordQuery(client, id, true)),
    combine: foundSessions,
  });
  return useMemo(() => {
    const found = new Map<string, Session>();
    if (!snapshot || !key) return found;
    const wanted = new Set(key.split("\n"));
    for (const s of snapshot.sessions) if (wanted.has(s.id)) found.set(s.id, s);
    for (const s of fetched) found.set(s.id, s);
    return found;
  }, [snapshot, key, fetched]);
}

export function useSession(sessionId: string | undefined): Session | undefined {
  return useSessionLookup(sessionId).session;
}

export function useProject(projectId: string | null | undefined): Project | undefined {
  return useSnapshotData((s) => s.projects.find((x) => x.id === projectId), undefined);
}

/**
 * Whether a session's project is archived, which makes its sessions read-only. The snapshot
 * lists active projects only and a project is archived, never deleted, so a project id it no
 * longer holds is an archived one. False without a project and while the snapshot loads.
 */
export function useProjectArchived(projectId: string | null | undefined): boolean {
  return useSnapshotData(
    (s) => Boolean(projectId) && !s.projects.some((x) => x.id === projectId),
    false,
  );
}

const NO_CHECKS: ProjectCheck[] = [];

/**
 * The project's checks a new session would freeze (§9 Project checks), read from its
 * `.codeden/project.json`; empty while loading and when it has none. Read again when the
 * New session view opens, so an edit to the file shows up.
 */
export function useProjectChecks(projectId: string): ProjectCheck[] {
  const client = useClient();
  const { data } = useQuery({
    queryKey: ["project-checks", projectId] as const,
    queryFn: () => client.listProjectChecks(projectId),
    staleTime: 30_000,
    // A server restart mid-request must not hide the option until the view opens again.
    retry: 3,
  });
  return data ?? NO_CHECKS;
}

/** Root turns a transcript opens with, and each page of earlier ones adds. */
export const TRANSCRIPT_PAGE_TURNS = 20;

/**
 * Load a session's transcript into the live store and return it. Only its latest root turns are
 * fetched (`turns`, a page by default), reaching back to `item` when given (a search hit), so a
 * long-lived session never downloads its whole history; `useEarlierTurns` adds earlier pages.
 * Every caller shares the session's one transcript in the store.
 */
export function useTranscript(
  sessionId: string | undefined,
  opts: { turns?: number; item?: string } = {},
): {
  transcript: TranscriptState | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useClient();
  const queryClient = useQueryClient();
  const turns = opts.turns ?? TRANSCRIPT_PAGE_TURNS;
  const item = opts.item;
  const query = useQuery({
    queryKey: ["session", sessionId, turns, item ?? null],
    queryFn: () => client.getSessionSnapshot(sessionId ?? "", { turns, ...(item ? { item } : {}) }),
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

/** The root turns before a loaded transcript's earliest one, and loading them a page at a time. */
export interface EarlierTurns {
  /** How many there are on the server (0 once the whole thread is loaded). */
  count: number;
  loading: boolean;
  /** Load the page before the earliest loaded turn into the session's transcript. */
  load: () => void;
}

/** Earlier root turns of a session's loaded transcript (scrolling up a long session). */
export function useEarlierTurns(sessionId: string): EarlierTurns {
  const client = useClient();
  const count = useTranscriptsStore((s) => s.byId[sessionId]?.earlierTurns ?? 0);
  const page = useMutation({
    mutationFn: async () => {
      const t = useTranscriptsStore.getState().byId[sessionId];
      const before = t?.rootThreadId ? t.threads[t.rootThreadId]?.turnIds[0] : undefined;
      if (!t || !before || t.earlierTurns === 0) return;
      const snap = await client.getSessionSnapshot(sessionId, {
        turns: TRANSCRIPT_PAGE_TURNS,
        before,
      });
      useTranscriptsStore.getState().load(snap);
    },
    onError: (error) => toast.error("Couldn't load earlier turns", { description: error.message }),
  });
  return {
    count,
    loading: page.isPending,
    load: () => {
      if (!page.isPending) page.mutate();
    },
  };
}
