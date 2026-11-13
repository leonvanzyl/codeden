import { isFactoryMode } from "@codeden/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bot,
  FileText,
  FolderGit2,
  GitBranch,
  MessageSquarePlus,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { AutomationsPanel } from "@/components/automations/automations-panel";
import { SectionLabel } from "@/components/common/bits";
import { AutonomyModeButton } from "@/components/factory/autonomy-dialog";
import { FactoryPanel } from "@/components/factory/factory-panel";
import { ProjectGithub } from "@/components/github/project-github";
import { SessionsList } from "@/components/project/lists";
import { NowNext } from "@/components/project/now-next";
import { ProjectTile } from "@/components/shell/sidebar/project-group";
import { Button } from "@/components/ui/button";
import { ProjectSpendCard } from "@/components/usage/project-spend-card";
import { useProjectStatus } from "@/lib/orchestration";
import { useSnapshot } from "@/lib/queries";
import { type SessionView, sessionCounts, sessionsInView } from "@/lib/session-filter";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

export type ProjectTab = "overview" | "github";

type ProjectSearch = { tab?: ProjectTab; archived?: boolean };

/** Project home: Now / Next, factory panel, sessions and automations, and GitHub (§8.4, §9). */
export function ProjectPage({
  projectId,
  tab,
  sessionView = "active",
}: {
  projectId: string;
  tab: ProjectTab;
  /** Active sessions, or the archived ones (the sidebar's "N archived" row opens these). */
  sessionView?: SessionView;
}) {
  const { data } = useSnapshot();
  const navigate = useNavigate();
  const { work } = useProjectStatus(projectId);
  const sessionsRef = useRef<HTMLElement>(null);
  const showArchived = sessionView === "archived";
  useEffect(() => {
    if (showArchived) sessionsRef.current?.scrollIntoView({ block: "start" });
  }, [showArchived]);
  const project = data?.projects.find((p) => p.id === projectId);
  if (!data || !project) return null;
  const counts = sessionCounts(data.sessions, projectId);
  const listed = sessionsInView(data.sessions, projectId, sessionView);
  const factory = isFactoryMode(project.autonomyMode);
  const titleOf = (id: string | null) => data.sessions.find((s) => s.id === id)?.title ?? null;
  const go = (search: ProjectSearch) =>
    void navigate({ to: "/projects/$projectId", params: { projectId }, search, replace: true });
  const tabSearch: ProjectSearch = {
    ...(tab === "overview" ? {} : { tab }),
    ...(showArchived ? { archived: true } : {}),
  };

  return (
    <>
      <PageHeader
        icon={<ProjectTile project={project} className="size-5 text-2xs" />}
        title={project.name}
        meta={
          <span className="flex items-center gap-2">
            {project.kind === "github" ? (
              <span className="flex items-center gap-1" data-testid="project-github-repo">
                <GitBranch className="size-3" /> {project.github.owner}/{project.github.repo}
                {project.remoteWarning && (
                  <button
                    type="button"
                    onClick={() => go({ tab: "github" })}
                    title="The folder no longer has this GitHub remote on origin"
                    aria-label="GitHub remote missing"
                    className="text-status-waiting"
                  >
                    <AlertTriangle className="size-3" />
                  </button>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <FolderGit2 className="size-3" /> Local folder
              </span>
            )}
            <AutonomyModeButton project={project} />
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/projects/$projectId/vision" params={{ projectId }}>
                <FileText /> Vision
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/projects/$projectId/pm" params={{ projectId }}>
                <Bot /> Talk to the PM
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/projects/$projectId/new" params={{ projectId }}>
                <MessageSquarePlus /> New session
              </Link>
            </Button>
          </>
        }
      />
      <div
        className="flex h-10 shrink-0 items-end gap-4 border-b border-border px-6"
        role="tablist"
      >
        {(["overview", "github"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => go(t === "overview" ? {} : { tab: t })}
            className={cn(
              "-mb-px border-b-2 border-transparent pb-2 text-[13px] text-muted-foreground hover:text-foreground",
              tab === t && "border-primary text-foreground",
            )}
          >
            {t === "overview" ? "Overview" : "GitHub"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-6xl space-y-8 px-6 py-6">
          {tab === "github" ? (
            <ProjectGithub project={project} />
          ) : (
            <>
              <NowNext work={work} projectId={projectId} titleOf={titleOf} />
              {factory && <FactoryPanel project={project} />}
              <ProjectSpendCard projectId={projectId} />
              <section ref={sessionsRef} className="scroll-mt-6" aria-label="Sessions">
                <div className="mb-2 flex items-center gap-3">
                  <SectionLabel>Sessions</SectionLabel>
                  <div className="flex items-center gap-1" role="tablist" aria-label="Show">
                    {(["active", "archived"] as const).map((view) => (
                      <button
                        key={view}
                        type="button"
                        role="tab"
                        aria-selected={sessionView === view}
                        onClick={() => {
                          const { archived: _archived, ...rest } = tabSearch;
                          go(view === "archived" ? { ...rest, archived: true } : rest);
                        }}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground",
                          sessionView === view && "bg-accent text-foreground",
                        )}
                      >
                        {view === "active" ? "Active" : "Archived"} · {counts[view]}
                      </button>
                    ))}
                  </div>
                </div>
                {listed.length > 0 ? (
                  <SessionsList sessions={listed} />
                ) : (
                  <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    {showArchived
                      ? "No archived sessions. Archive one from its menu to tidy the sidebar."
                      : "No active sessions."}
                  </p>
                )}
              </section>
              <section id="automations">
                <div className="mb-2 flex items-center gap-2">
                  <SectionLabel>Automations</SectionLabel>
                  <Link
                    to="/projects/$projectId/automations"
                    params={{ projectId }}
                    className="ml-auto text-2xs text-muted-foreground hover:text-foreground"
                  >
                    Manage, runs and templates →
                  </Link>
                </div>
                <AutomationsPanel projectId={projectId} compact />
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
