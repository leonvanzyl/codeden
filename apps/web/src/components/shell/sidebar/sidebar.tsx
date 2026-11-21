import type { Session } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  ChartColumnBig,
  FolderPlus,
  Inbox,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Hotkey, SectionLabel } from "@/components/common/bits";
import { StatusDot } from "@/components/common/status-dot";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { splitPinned } from "@/lib/project-order";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { Logo } from "../logo";
import { NavRow, rowBase } from "./nav-row";
import { SortableProjectGroup } from "./project-list";
import { SidebarFooter } from "./sidebar-footer";

/** Waiting sessions in a soft amber box; hidden when nothing waits (§11.1). */
function WaitingOnYou({
  sessions,
  projectName,
}: {
  sessions: Session[];
  projectName: (id: string | null) => string;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="mx-3 mt-2 rounded-lg border border-status-waiting/15 bg-status-waiting/[0.04] p-1">
      <div className="flex items-center gap-2 px-2 pt-1 pb-0.5">
        <span className="text-3xs font-semibold tracking-[0.08em] text-status-waiting/90 uppercase">
          Waiting on you
        </span>
        <span className="ml-auto text-3xs font-semibold text-status-waiting tabular-nums">
          {sessions.length}
        </span>
      </div>
      {sessions.slice(0, 4).map((s) => (
        <NavRow
          key={s.id}
          href={`/sessions/${s.id}`}
          link={{ to: "/sessions/$sessionId", params: { sessionId: s.id } }}
          className="h-auto py-1"
        >
          <StatusDot status={s.status} className="mt-0.5 self-start" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{s.title ?? s.purpose}</span>
            <span className="block truncate text-3xs text-muted-foreground">
              {projectName(s.projectId)}
            </span>
          </span>
        </NavRow>
      ))}
    </div>
  );
}

/**
 * Left sidebar (§13): orchestrator, inbox, waiting work, projects, runner status. In the
 * phone/tablet drawer, `onClose` replaces the collapse button.
 */
export function Sidebar({ width, onClose }: { width: number | string; onClose?: () => void }) {
  const { data } = useSnapshot();
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const openAddProject = useUiStore((s) => s.setAddProjectOpen);

  const inbox = data?.inbox.filter((i) => i.status === "open") ?? [];
  const urgent = inbox.some((i) => i.kind === "approval" || i.kind === "question");
  const orchestrator = data?.sessions.findLast((s) => s.role === "orchestrator" && !s.archivedAt);
  const waiting = data?.sessions.filter((s) => s.status === "waiting" && s.role === "agent") ?? [];
  const projectName = (id: string | null) => data?.projects.find((p) => p.id === id)?.name ?? "";
  const { pinned, others } = splitPinned(data?.projects ?? []);

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <Logo className="size-[22px]" />
        <span className="text-[15px] font-semibold tracking-tight">CodeDen</span>
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground"
                onClick={toggleSidebar}
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Collapse sidebar · Ctrl B</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => openPalette(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background/40 px-2.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:border-input hover:text-foreground pointer-coarse:h-10"
        >
          <Search className="size-3.5" />
          <span>Search or run…</span>
          <Hotkey keys="Ctrl K" className="ml-auto" />
        </button>
      </div>

      <nav className="flex flex-col gap-px px-3">
        <NavRow href="/" link={{ to: "/" }}>
          <span className="flex size-4 items-center justify-center rounded-[5px] bg-primary/15 text-primary">
            <Bot className="size-3" />
          </span>
          <span className="flex-1 font-medium">Orchestrator</span>
          {orchestrator && <StatusDot status={orchestrator.status} />}
        </NavRow>
        <NavRow href="/inbox" link={{ to: "/inbox" }}>
          <Inbox className="size-4 text-muted-foreground" />
          <span className="flex-1">Inbox</span>
          {inbox.length > 0 && (
            <span
              className={cn(
                "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-3xs font-semibold tabular-nums",
                urgent
                  ? "bg-status-waiting text-black/80"
                  : "bg-sidebar-accent text-sidebar-foreground",
              )}
            >
              {inbox.length}
            </span>
          )}
        </NavRow>
        <NavRow href="/reports" link={{ to: "/reports" }}>
          <ChartColumnBig className="size-4 text-muted-foreground" />
          <span className="flex-1">Usage</span>
        </NavRow>
      </nav>

      <WaitingOnYou sessions={waiting} projectName={projectName} />

      {/*
        The scroll area wraps its content in a `display: table` box that grows to the widest
        row, which stops `truncate` from ever applying. A block box keeps rows at the sidebar's
        width, so titles end in an ellipsis and trailing details stay visible.
      */}
      <ScrollArea
        data-testid="sidebar-projects"
        className="mt-3 min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!"
      >
        <div className="flex min-w-0 flex-col gap-1 px-3 pb-3">
          {pinned.length > 0 && (
            <section aria-label="Pinned projects" className="flex flex-col gap-1">
              <div className="flex h-7 items-center gap-1.5 pt-1 pl-2">
                <Pin className="size-3 text-muted-foreground/70" />
                <SectionLabel>Pinned</SectionLabel>
              </div>
              <SortableProjectGroup
                projects={pinned}
                sessions={data?.sessions ?? []}
                label="Pinned"
              />
            </section>
          )}
          <section aria-label="Projects" className="flex flex-col gap-1">
            <div className={cn("flex h-7 items-center pl-2", pinned.length > 0 && "mt-2")}>
              <SectionLabel>Projects</SectionLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto text-muted-foreground"
                    aria-label="Add project"
                    onClick={() => openAddProject(true)}
                  >
                    <Plus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add a project</TooltipContent>
              </Tooltip>
            </div>
            <SortableProjectGroup
              projects={others}
              sessions={data?.sessions ?? []}
              label="Projects"
            />
          </section>
          {data && data.projects.length === 0 && (
            <button
              type="button"
              onClick={() => openAddProject(true)}
              className={cn(rowBase, "text-muted-foreground")}
            >
              <FolderPlus className="size-4" /> Add your first project
            </button>
          )}
          {data && (
            <Link
              to="/setup"
              className="mt-2 px-2 text-3xs text-muted-foreground/60 hover:text-muted-foreground"
            >
              Run first-time setup again
            </Link>
          )}
        </div>
      </ScrollArea>

      <SidebarFooter />
    </aside>
  );
}
