import type { AutonomyLevel } from "@codeden/contracts";
import { FolderX, MessageSquareDashed } from "lucide-react";
import { useEffect, useMemo } from "react";
import { EmptyState } from "@/components/common/bits";
import { Composer } from "@/components/composer/composer";
import { DraftOptions } from "@/components/composer/draft-options";
import { ConflictCard } from "@/components/project/conflict-card";
import { NewSessionHeader } from "@/components/project/new-session-header";
import { useStartDraft } from "@/components/project/use-start-draft";
import { resolveDraftChoice } from "@/lib/new-session";
import { useProject, useSnapshot, useSnapshotData } from "@/lib/queries";
import { newSessionDraftKey, useComposerStore } from "@/stores/composer";
import { getNewSessionDraft, useNewSessionStore } from "@/stores/new-session";

/**
 * New session (§13): a draft that looks and works like a session, with the session composer
 * (pickers, attachments, `@` and `/`, the send keys). Nothing exists until the first send starts
 * the session; the draft (text, options, work key) is kept in the browser until then.
 */
export function NewSessionPage({ projectId }: { projectId: string }) {
  const loaded = useSnapshot().data !== undefined;
  const project = useProject(projectId);
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const defaultAutonomy = useSnapshotData<AutonomyLevel>(
    (s) => s.settings.autonomy.default,
    "auto",
  );
  // Settings → Providers → Agent sessions: provider, model and effort.
  const agent = useSnapshotData((s) => s.settings.providers.agent, null);
  const draft = useNewSessionStore((s) => getNewSessionDraft(s, projectId));
  const { setChoice, setWorkKey } = useNewSessionStore.getState();
  const resolved = useMemo(
    () =>
      resolveDraftChoice(draft.choice, {
        providers,
        project,
        agent,
        defaultAutonomy,
      }),
    [draft.choice, providers, project, agent, defaultAutonomy],
  );
  const start = useStartDraft(projectId, resolved, draft.workKey);

  // Open ready to type, like a session.
  useEffect(() => useComposerStore.getState().focus(), []);

  // Nothing until the snapshot has loaded, so a cold start never flashes "not found".
  if (!loaded) return null;
  if (!project) {
    return (
      <EmptyState icon={<FolderX />} title="Project not found" className="flex-1">
        It may have been archived.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="new-session">
      <NewSessionHeader
        project={project}
        workKey={draft.workKey}
        onWorkKey={(key) => setWorkKey(projectId, key)}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <EmptyState icon={<MessageSquareDashed />} title="New session" className="flex-1">
          Describe the task. The agent works in its own worktree and branch. Nothing is created
          until you send.
        </EmptyState>
      </div>
      {start.conflict && (
        <div className="mx-auto w-full max-w-[46rem] px-3 pb-2 sm:px-6">
          <ConflictCard
            conflict={start.conflict}
            decideWith={start.decide}
            onResolved={start.onConflictResolved}
            startBlocked={start.startBlocked}
            replace
          />
        </div>
      )}
      <Composer
        draftKey={newSessionDraftKey(projectId)}
        source={{ kind: "project", projectId, provider: resolved.provider?.id ?? null }}
        placeholder="Describe the task — @ to mention files, / for commands and skills"
        options={
          <DraftOptions
            providers={providers}
            choice={draft.choice}
            resolved={resolved}
            onChange={(choice) => setChoice(projectId, choice)}
          />
        }
        sending={start.sending}
        onSend={(input) => start.send(input)}
      />
    </div>
  );
}
