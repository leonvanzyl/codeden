import type { Session, UserInputInit } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { toInputAttachments } from "@/components/composer/attachments";
import {
  ComposerBox,
  canSendDraft,
  composerPlaceholders,
  isSendKey,
} from "@/components/composer/composer-box";
import { MobileNavButton } from "@/components/shell/mobile-nav";
import { ThreadView } from "@/components/thread/thread-view";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import type { OrchestrationRole } from "@/lib/api/feature-apis";
import { useProject, useSnapshotData } from "@/lib/queries";
import { getDraft, useComposerStore } from "@/stores/composer";
import { ReadOnlyBadge, RoleBadge } from "./role-badge";

/** Composer draft key while the role session does not exist yet. */
export const roleDraftKey = (role: OrchestrationRole, projectId: string | null) =>
  role === "orchestrator" ? "role:orchestrator" : `role:pm:${projectId}`;

/** The orchestrator or a project's PM session from the snapshot (`roleSessions` first). */
export function useRoleSession(
  role: OrchestrationRole,
  projectId: string | null,
): Session | undefined {
  return useSnapshotData((s) => {
    const ref =
      role === "orchestrator" ? s.roleSessions?.orchestrator : s.roleSessions?.pms[projectId ?? ""];
    const byRef = ref ? s.sessions.find((x) => x.id === ref) : undefined;
    if (byRef) return byRef;
    return s.sessions
      .filter((x) => x.role === role && (role === "orchestrator" || x.projectId === projectId))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  }, undefined);
}

/**
 * Composer for a role session that does not exist yet: the first message, with any pasted or
 * attached images and files, creates it. Session controls (options, queue/steer, stop) come
 * with the session's own composer. Also the Factory view's quick chat before the PM exists.
 */
export function StartComposer({
  kind: role,
  projectId,
}: {
  kind: OrchestrationRole;
  projectId: string | null;
}) {
  const client = useClient();
  const key = roleDraftKey(role, projectId);
  const draft = useComposerStore((s) => getDraft(s, key));
  const { setText, clear } = useComposerStore.getState();
  // The input is captured at submit time: `onMutate` clears the draft before `mutationFn` runs.
  const send = useMutation({
    mutationFn: (input: UserInputInit) => client.orchestration.send(role, projectId, input),
    onMutate: () => clear(key),
    onError: (e, input) => {
      setText(key, input.text);
      toast.error("Message not sent", { description: e.message });
    },
  });
  const canSend = canSendDraft(draft);
  const submit = () => {
    if (!canSend) return;
    send.mutate({ text: draft.text.trim(), attachments: toInputAttachments(draft.attachments) });
  };
  return (
    <ComposerBox
      draftKey={key}
      placeholder={composerPlaceholders[role]}
      onKeyDown={(e) => {
        if (!isSendKey(e)) return;
        e.preventDefault();
        submit();
      }}
      options={
        <span className="px-2 text-2xs text-muted-foreground">
          The first message starts the {role === "orchestrator" ? "orchestrator" : "PM"}.
        </span>
      }
    >
      <Button
        size="icon-sm"
        className="rounded-full transition-transform hover:scale-105"
        onClick={submit}
        disabled={!canSend || send.isPending}
        aria-label="Send"
      >
        <ArrowUp />
      </Button>
    </ComposerBox>
  );
}

/**
 * The orchestrator chat or a project's PM chat (§8.1). Uses the role session when it exists;
 * otherwise the first message creates it through `/api/orchestration`.
 */
export function RoleChat({
  kind: role,
  projectId,
  empty,
}: {
  /** Which role chat: the orchestrator or a project's PM. */
  kind: OrchestrationRole;
  projectId: string | null;
  /** Empty-state content; gets the composer draft key suggestions should write to. */
  empty: (draftKey: string) => ReactNode;
}) {
  const session = useRoleSession(role, projectId);
  const project = useProject(projectId);
  if (session) return <ThreadView sessionId={session.id} empty={empty(session.id)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="role-chat-start">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <MobileNavButton />
        <RoleBadge role={role} />
        <h1 className="truncate text-[14px] font-medium">
          {role === "orchestrator"
            ? "Orchestrator"
            : `${project?.name ?? "Project"} · Project manager`}
        </h1>
        <span className="text-2xs text-muted-foreground">Not started</span>
        <ReadOnlyBadge className="ml-auto" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {empty(roleDraftKey(role, projectId))}
      </div>
      <StartComposer kind={role} projectId={projectId} />
    </div>
  );
}
