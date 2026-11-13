import type { ArchiveSessionResponse, ProviderInfo, Session } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useClient } from "./api";
import { copyWithFeedback } from "./copy";
import { useSnapshotData } from "./queries";

/** Sessions that can be stopped from a menu: ones with a turn running or a question open. */
export const canStop = (session: Pick<Session, "status">) =>
  session.status === "running" || session.status === "waiting";

const NOT_STARTED = new Set<Session["status"]>(["created", "queued", "starting"]);

/**
 * Whether the Fork action applies to a session at all: an agent session on a provider that
 * reports `capabilities.fork` (Principle 5: never the provider's name).
 */
export const forkSupported = (session: Session, provider: ProviderInfo | undefined) =>
  session.role === "agent" && provider?.capabilities.fork === true;

/**
 * Why a session that supports forking can't be forked right now, or null when it can (the
 * server checks the same, §9).
 */
export function forkBlocked(session: Session): string | null {
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.resumeToken) return "No conversation to fork yet";
  if (!session.branch) return "Only sessions on a git branch can be forked";
  return null;
}

/**
 * Sessions that can be turned into an automation ("Make an automation…"): agent sessions in a
 * project. PM and orchestrator sessions are conversations, not repeatable tasks.
 */
export const canMakeAutomation = (session: Pick<Session, "role" | "projectId">) =>
  session.role === "agent" && session.projectId !== null;

/** A link to the session in this CodeDen (no token: the browser's cookie signs it in). */
export const sessionLink = (sessionId: string, origin = window.location.origin) =>
  `${origin}/sessions/${encodeURIComponent(sessionId)}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const brief = (text: string | null) =>
  text && text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : (text ?? undefined);

/**
 * Toast for an archive: what happened to the worktree, with Undo. A worktree kept because of
 * uncommitted changes offers Remove anyway; a removal that failed (a file still in use) offers
 * Try again.
 */
export function announceArchive(
  result: ArchiveSessionResponse,
  actions: { undo: () => void; retry: () => void; force: () => void },
): void {
  const undo = { label: "Undo", onClick: actions.undo };
  const { status, message: detail } = result.worktree;
  if (status === "removed") {
    toast.success("Session archived and its worktree removed", {
      action: undo,
      description: brief(detail),
    });
  } else if (status === "none") {
    toast.success("Session archived", { action: undo });
  } else if (status === "kept_changes") {
    toast("Session archived. The worktree has uncommitted changes, so it was kept.", {
      action: { label: "Remove anyway", onClick: actions.force },
      cancel: undo,
      duration: 10_000,
    });
  } else {
    toast.warning("Session archived, but its worktree couldn't be removed yet", {
      description: brief(detail),
      action: { label: "Try again", onClick: actions.retry },
      cancel: undo,
      duration: 10_000,
    });
  }
}

/**
 * Fork a session (§9): at its latest moment, or from a finished turn of its own ("Fork from
 * here"), then open the fork. `canFork` says whether the provider can fork at all, `blocked`
 * why it can't right now (null when it can).
 */
export function useForkSession(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  // Copying the conversation can take a moment (a provider may start a process for it).
  const fork = useMutation({
    mutationFn: (turnId: string | undefined) =>
      turnId ? client.forkSession(session.id, { turnId }) : client.forkSession(session.id),
    onMutate: () => ({ toastId: toast.loading("Forking the session…") }),
    onSuccess: ({ sessionId }, turnId, context) => {
      toast.success("Forked into a new session", {
        id: context?.toastId,
        description: turnId
          ? "It has the conversation and the code as they were after that turn. The original is unchanged."
          : "It has the conversation and the code so far. The original is unchanged.",
      });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
    },
    onError: (error, _vars, context) => toast.error(message(error), { id: context?.toastId }),
  });
  const provider = useSnapshotData(
    (s) => s.runner.providers.find((p) => p.id === session.provider),
    undefined,
  );
  const canFork = forkSupported(session, provider);
  return {
    canFork,
    blocked: canFork ? (fork.isPending ? "Forking…" : forkBlocked(session)) : null,
    /** A fork is under way (its "Forking the session…" toast is showing). */
    pending: fork.isPending,
    /** Fork at the latest moment, or through the end of `turnId`. */
    fork: (turnId?: string) => fork.mutate(turnId),
  };
}

/**
 * What you can do to a session from its row menu, the thread header's ⋯ menu or the command
 * palette: open, rename, copy its link, make an automation from it, stop, fork, archive (with
 * Undo) and unarchive. They all use this, so they show the same toasts.
 */
export function useSessionActions(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  const onError = (error: unknown) => toast.error(message(error));

  const stop = useMutation({
    mutationFn: () => client.stopSession(session.id),
    onSuccess: () => toast("Session stopped"),
    onError,
  });
  const unarchive = useMutation({
    mutationFn: () => client.unarchiveSession(session.id),
    onSuccess: () => toast.success("Session restored to the sidebar"),
    onError,
  });
  const archive = useMutation({
    mutationFn: (force: boolean) => client.archiveSession(session.id, { force }),
    onSuccess: (result, force) =>
      announceArchive(result, {
        undo: () => unarchive.mutate(),
        retry: () => archive.mutate(force),
        force: () => archive.mutate(true),
      }),
    onError,
  });
  const rename = useMutation({
    mutationFn: (title: string) => client.updateSession(session.id, { title }),
    onError,
  });
  const fork = useForkSession(session);

  return {
    open: () => void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } }),
    /** Save a new title; blank or unchanged titles are ignored. */
    rename: (title: string) => {
      const next = title.trim().slice(0, 200);
      if (next && next !== (session.title ?? session.purpose)) rename.mutate(next);
    },
    copyLink: async () => {
      await copyWithFeedback(sessionLink(session.id), "Link copied");
    },
    canMakeAutomation: canMakeAutomation(session),
    /** Open the New automation editor prefilled from this session; nothing is saved yet. */
    makeAutomation: () => {
      if (!session.projectId) return;
      void navigate({
        to: "/projects/$projectId/automations/new",
        params: { projectId: session.projectId },
        search: { session: session.id },
      });
    },
    canStop: canStop(session),
    stop: () => stop.mutate(),
    archived: Boolean(session.archivedAt),
    archive: () => archive.mutate(false),
    unarchive: () => unarchive.mutate(),
    /** The provider can fork this session's conversation: show the Fork action. */
    canFork: fork.canFork,
    /** Why Fork is disabled right now (null when it can run). */
    forkBlocked: fork.blocked,
    fork: () => fork.fork(),
  };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
