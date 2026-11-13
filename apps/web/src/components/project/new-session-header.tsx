import type { Project } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { KeyRound, MoreHorizontal, X } from "lucide-react";
import { MobileNavButton } from "@/components/shell/mobile-nav";
import { ProjectTile } from "@/components/shell/sidebar/project-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Top bar of the New session draft, laid out like a session's: the project, "New session", and
 * a ⋯ control for the optional work key, which is sent with the first message. A key that is set
 * shows as a chip.
 */
export function NewSessionHeader({
  project,
  workKey,
  onWorkKey,
}: {
  project: Project;
  workKey: string;
  onWorkKey: (key: string) => void;
}) {
  const key = workKey.trim();
  return (
    <header className="@container flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <MobileNavButton />
      <ProjectTile project={project} />
      <div className="flex min-w-0 shrink items-baseline gap-2 overflow-hidden">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="hidden shrink-0 text-[13px] text-muted-foreground hover:text-foreground @[36rem]:inline"
        >
          {project.name} <span className="text-muted-foreground/50">/</span>
        </Link>
        <h1 className="min-w-0 truncate text-[14px] font-medium">New session</h1>
        <span className="shrink-0 text-2xs text-muted-foreground">Not started</span>
      </div>
      {key && (
        <span
          title="Work key: sessions with the same key are flagged as duplicates"
          className="ml-1 inline-flex h-6 max-w-44 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground [&_svg]:size-3"
          data-testid="work-key-chip"
        >
          <KeyRound />
          <span className="truncate font-mono">{key}</span>
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Session options"
            >
              <MoreHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-2">
            <Label htmlFor="new-session-work-key" className="text-[13px]">
              Work key <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id="new-session-work-key"
                value={workKey}
                onChange={(e) => onWorkKey(e.target.value)}
                placeholder="issue:151"
                className="font-mono text-[13px]"
              />
              {workKey && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => onWorkKey("")}
                  aria-label="Clear the work key"
                >
                  <X />
                </Button>
              )}
            </div>
            <p className="text-2xs text-muted-foreground">
              Sessions with the same key are flagged as duplicates before anything starts. Without
              one, CodeDen derives it from the task.
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
