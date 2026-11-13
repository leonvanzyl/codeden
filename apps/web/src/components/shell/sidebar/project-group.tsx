import type { Project, Session } from "@codeden/contracts";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { Link } from "@tanstack/react-router";
import { Archive, Bot, ChevronRight, GripVertical, House, Plus } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { StatusDot } from "@/components/common/status-dot";
import { statusTone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { childGroup, childRow, NavRow, rowBase, useIsActive } from "./nav-row";
import { ProjectAutomations } from "./project-automations";
import { type GroupPosition, useProjectMenu } from "./project-menu";
import { RowMenu, RowMenuButton, useRowMenu } from "./row-menu";
import { SessionRow } from "./session-row";

const order: Record<string, number> = { waiting: 0, running: 1, starting: 1, failed: 2, queued: 3 };
const LIMIT = 5;

function sortSessions(list: Session[]): Session[] {
  return [...list].sort(
    (a, b) =>
      (order[a.status] ?? 4) - (order[b.status] ?? 4) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

/** Project tile: initial on a tinted square. */
export function ProjectTile({ project, className }: { project: Project; className?: string }) {
  const hue = (project.slug.split("").reduce((h, c) => h + c.charCodeAt(0), 0) * 29) % 360;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] text-3xs font-bold uppercase",
        className,
      )}
      style={{ background: `oklch(0.7 0.11 ${hue} / 0.2)`, color: `oklch(0.75 0.13 ${hue})` }}
      aria-hidden
    >
      {project.name.charAt(0)}
    </span>
  );
}

/** Drag wiring from `useSortable`, for a project row in a sortable list (§13). */
export interface ProjectDrag {
  setNodeRef: (element: HTMLElement | null) => void;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  style: CSSProperties;
  isDragging: boolean;
}

/**
 * One project in the sidebar: header, PM, sessions, automations and archived sessions. The
 * header row drags after a few pixels (so clicks still expand and open), a grip in the gutter
 * starts a keyboard move, and its row menu pins, unpins and moves the project.
 */
export function ProjectGroup({
  project,
  sessions,
  drag,
  position,
}: {
  project: Project;
  sessions: Session[];
  drag: ProjectDrag;
  position: GroupPosition;
}) {
  const open = useLayoutStore((s) => s.expandedProjects[project.id] ?? false);
  const toggle = useLayoutStore((s) => s.toggleProject);
  const [showAll, setShowAll] = useState(false);
  const homeActive = useIsActive(`/projects/${project.id}`, false);
  const menu = useRowMenu();
  const entries = useProjectMenu(project, position);
  const pm = sessions
    .filter((s) => s.role === "pm")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const agents = sortSessions(sessions.filter((s) => s.role === "agent" && !s.archivedAt));
  const archived = sessions.filter((s) => s.role === "agent" && s.archivedAt).length;
  const visible = showAll ? agents : agents.slice(0, LIMIT);
  const attention = agents.some((s) => s.status === "waiting");
  const running = agents.filter((s) => statusTone[s.status] === "running").length;

  return (
    <div
      ref={drag.setNodeRef}
      style={drag.style}
      data-project-id={project.id}
      className={cn(
        "flex flex-col gap-px",
        open && "pb-1.5",
        drag.isDragging &&
          "relative z-10 rounded-md bg-sidebar shadow-md ring-1 ring-sidebar-border",
      )}
    >
      <RowMenu menu={menu} entries={entries}>
        <div
          {...drag.listeners}
          className={cn(rowBase, "group/head pr-1", homeActive && "text-sidebar-accent-foreground")}
        >
          <button
            type="button"
            ref={drag.setActivatorNodeRef}
            {...drag.attributes}
            aria-label={`Reorder ${project.name}`}
            className="absolute top-1/2 -left-3 flex h-5 w-3 -translate-y-1/2 cursor-grab items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-none transition-opacity group-hover/head:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => toggle(project.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
            aria-expanded={open}
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                open && "rotate-90",
              )}
            />
            <ProjectTile project={project} />
            <span className="truncate font-medium">{project.name}</span>
            {!open && (attention || running > 0) && (
              <span className="ml-auto flex items-center gap-1 pr-1">
                {attention && <span className="size-1.5 rounded-full bg-status-waiting" />}
                {running > 0 && (
                  <span className="text-3xs text-muted-foreground tabular-nums">{running}</span>
                )}
              </span>
            )}
          </button>
          {/* Actions never start a drag; the row around them does. */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 touch:opacity-100"
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="Project home"
            >
              <House className="size-3.5" />
            </Link>
            <Link
              to="/projects/$projectId/new"
              params={{ projectId: project.id }}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="New session"
            >
              <Plus className="size-3.5" />
            </Link>
            <RowMenuButton menu={menu} entries={entries} label={`${project.name} actions`} />
          </div>
        </div>
      </RowMenu>

      {open && (
        <div className={childGroup}>
          <NavRow
            href={`/projects/${project.id}/pm`}
            link={{ to: "/projects/$projectId/pm", params: { projectId: project.id } }}
            className={childRow}
          >
            <Bot className="size-3.5 shrink-0 text-primary/80" />
            <span className="flex-1 truncate">Project manager</span>
            <span className="rounded-full bg-primary/10 px-1.5 text-3xs font-medium text-primary">
              PM
            </span>
            {pm && <StatusDot status={pm.status} />}
          </NavRow>
          {visible.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
          {agents.length > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={cn(rowBase, childRow, "h-7 text-xs text-muted-foreground")}
            >
              {showAll ? "Show less" : `Show ${agents.length - LIMIT} more`}
            </button>
          )}
          <ProjectAutomations projectId={project.id} />
          {archived > 0 && (
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ archived: true }}
              className={cn(rowBase, childRow, "h-7 text-xs text-muted-foreground/70")}
            >
              <Archive className="size-3.5 shrink-0" />
              <span className="truncate">{archived} archived</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
