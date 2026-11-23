import { isActiveSession, type Project, type Session } from "@codeden/contracts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProjectActions } from "@/lib/project-actions";
import { showsProject } from "@/lib/project-pages";
import { canStop } from "@/lib/session-availability";

/**
 * Confirms archiving a project (§13), opened from its row menu. A project with sessions that
 * are working or about to (`ACTIVE_SESSION_STATUSES`: created, queued, starting, running or
 * waiting) can't be archived: they would carry on, or start, out of sight, so they are stopped
 * first. The server refuses the same (`project_has_active_sessions`) and its answer is shown
 * when it knows of one this list doesn't have. After archiving, a page of the project gives
 * way to the home page.
 */
export function ArchiveProjectDialog({
  project,
  sessions,
  open,
  onOpenChange,
}: {
  project: Project;
  /** The project's sessions, as the sidebar has them. */
  sessions: Session[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useProjectActions();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [busy, setBusy] = useState(false);
  const active = sessions.filter(isActiveSession);
  const working = active.length;
  // Stop is offered for a running or waiting session only; one that hasn't started is archived.
  const notStarted = active.some((s) => !canStop(s));

  async function archive() {
    setBusy(true);
    const onProject = showsProject(pathname, project.id, sessions);
    const done = await actions.archive(project);
    setBusy(false);
    if (!done) return;
    onOpenChange(false);
    if (onProject) void navigate({ to: "/" });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It leaves the project list, and its automations and factory stop. Its sessions'
            worktrees are removed, except any with uncommitted changes. Nothing in{" "}
            <span className="font-mono break-all">{project.path}</span> changes. To bring the
            project back, add the same folder again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {working > 0 && (
          <p className="text-sm text-status-waiting" role="status">
            {working === 1
              ? "1 session is still working or waiting to start. Stop it first."
              : `${working} sessions are still working or waiting to start. Stop them first.`}
            {notStarted && " A session that hasn't started yet has no Stop: archive it instead."}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || working > 0}
            onClick={(event) => {
              // Stay open until the server has answered; a failure keeps the dialog.
              event.preventDefault();
              void archive();
            }}
          >
            Archive project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
