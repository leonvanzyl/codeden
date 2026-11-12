import type { Session } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Copy,
  FolderTree,
  GitBranch,
  GitFork,
  MoreHorizontal,
  PanelRight,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { StatusDot } from "@/components/common/status-dot";
import { ReadOnlyBadge, RoleBadge } from "@/components/orchestration/role-badge";
import { MobileNavButton } from "@/components/shell/mobile-nav";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SessionCostChip } from "@/components/usage/session-cost";
import { useClient } from "@/lib/api";
import { statusLabel } from "@/lib/format";
import { platform } from "@/lib/platform";
import { useProject, useSession } from "@/lib/queries";
import { useSessionActions } from "@/lib/session-actions";
import { cn } from "@/lib/utils";
import { useViewport } from "@/lib/viewport";
import { useLayoutStore } from "@/stores/layout";
import { SessionGithubBadges } from "./session-github-badges";

function Chip({
  icon,
  children,
  title,
  className,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 max-w-44 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground [&_svg]:size-3",
        className,
      )}
    >
      {icon}
      <span className="truncate font-mono">{children}</span>
    </span>
  );
}

/** Where a forked session came from, linking to the source session. */
function ForkedFromChip({ sourceId, className }: { sourceId: string; className?: string }) {
  const source = useSession(sourceId);
  const title = source ? (source.title ?? source.purpose) : "another session";
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: sourceId }}
      title={`Forked from ${title}`}
      className={cn(
        "inline-flex h-6 max-w-44 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground hover:border-primary/40 hover:text-foreground [&_svg]:size-3",
        className,
      )}
    >
      <GitFork />
      <span className="truncate">Fork of {title}</span>
    </Link>
  );
}

/**
 * Top bar of a thread: title, status, branch, worktree, cost and actions. The model and the
 * permission level live under the message box (the composer), not here, so they aren't shown
 * twice.
 */
export function ThreadHeader({ session, running }: { session: Session; running: boolean }) {
  const client = useClient();
  const project = useProject(session.projectId);
  const layout = useLayoutStore();
  const { sheetPanels, phone } = useViewport();
  const panelOpen = sheetPanels ? layout.rightSheetOpen : layout.rightOpen;
  const stop = useMutation({
    mutationFn: () => client.interrupt(session.id),
    onSuccess: () => toast("Turn stopped"),
  });
  // Stop, archive and unarchive are shared with the sidebar's session row menu.
  const actions = useSessionActions(session);

  const title =
    session.role === "orchestrator"
      ? "Orchestrator"
      : session.role === "pm"
        ? "Project manager"
        : (session.title ?? session.purpose);

  return (
    <header className="@container flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <MobileNavButton />
      {session.role === "agent" ? (
        <StatusDot status={session.status} />
      ) : (
        <RoleBadge role={session.role} short />
      )}
      <div className="flex min-w-0 shrink items-baseline gap-2 overflow-hidden sm:min-w-[10rem]">
        {project && session.role !== "orchestrator" && (
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            className="hidden shrink-0 text-[13px] text-muted-foreground hover:text-foreground @[48rem]:inline"
          >
            {project.name} <span className="text-muted-foreground/50">/</span>
          </Link>
        )}
        <h1 className="min-w-0 truncate text-[14px] font-medium">{title}</h1>
        <span
          className={cn(
            "shrink-0 text-2xs",
            session.status === "waiting" ? "text-status-waiting" : "text-muted-foreground",
          )}
        >
          {statusLabel[session.status]}
          {session.archivedAt && " · Archived"}
        </span>
      </div>

      <div className="ml-1 hidden min-w-0 shrink items-center gap-1.5 overflow-hidden @[36rem]:flex">
        {session.branch && (
          <Chip
            className="hidden @[54rem]:inline-flex"
            icon={<GitBranch />}
            title={`Base: ${session.baseBranch ?? "main"}`}
          >
            {session.branch}
          </Chip>
        )}
        {session.worktreePath && (
          <Chip
            className={cn(
              "hidden @[70rem]:inline-flex",
              session.worktreeRemovedAt && "border-dashed opacity-60",
            )}
            icon={<FolderTree />}
            title={
              session.worktreeRemovedAt
                ? `Worktree cleaned up. It's recreated from ${session.branch ?? "its branch"} when you send a message.`
                : session.worktreePath
            }
          >
            {session.worktreePath.split(/[\\/]/).at(-1)}
          </Chip>
        )}
        {session.forkedFrom && (
          <ForkedFromChip
            sourceId={session.forkedFrom.sessionId}
            className="hidden @[48rem]:inline-flex"
          />
        )}
        <SessionCostChip sessionId={session.id} className="hidden @[40rem]:inline-flex" />
        {/* Agents show their model and permissions under the message box; the PM and the
            orchestrator have no permission picker there, so their read-only badge stays. */}
        {session.role !== "agent" && <ReadOnlyBadge />}
        <SessionGithubBadges session={session} className="hidden @[44rem]:inline-flex" />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {running && (
          <Button
            size="xs"
            variant="outline"
            className="mr-1 gap-1.5"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
          >
            <Square className="size-2.5 fill-current" /> Stop
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "text-muted-foreground",
                layout.drawerOpen && "bg-accent text-foreground",
                // Phones use the panel's Terminal tab instead of the bottom drawer.
                phone && "hidden",
              )}
              onClick={() => layout.toggleDrawer()}
              aria-label="Toggle terminal"
            >
              <SquareTerminal />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Terminal · Ctrl J</TooltipContent>
        </Tooltip>
        {session.worktreePath && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("text-muted-foreground", panelOpen && "bg-accent text-foreground")}
                onClick={() => layout.toggleRight(!panelOpen)}
                aria-label="Toggle right panel"
              >
                <PanelRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Right panel · Ctrl \</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="More"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {session.branch && (
              <DropdownMenuItem
                onSelect={() =>
                  void platform
                    .writeClipboard(session.branch ?? "")
                    .then(() => toast.success("Branch copied"))
                }
              >
                <Copy /> Copy branch name
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => layout.openRightTab("details")}>
              <Bot /> Session details
            </DropdownMenuItem>
            {actions.canFork && (
              <DropdownMenuItem
                disabled={actions.forkBlocked !== null}
                title={actions.forkBlocked ?? undefined}
                onSelect={actions.fork}
              >
                <GitFork />
                <span className="flex min-w-0 flex-col">
                  Fork session
                  <span className="text-2xs text-muted-foreground">
                    {actions.forkBlocked ?? "Try another approach in a new worktree"}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            {session.role === "agent" && (
              <>
                <DropdownMenuSeparator />
                {actions.archived ? (
                  <DropdownMenuItem onSelect={actions.unarchive}>
                    <ArchiveRestore /> Unarchive
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={actions.archive}>
                    <Archive /> Archive session
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={actions.stop}>
                  <X /> Stop session
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
