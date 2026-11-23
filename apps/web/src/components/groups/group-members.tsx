import type { Project, ProjectGroup } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { SettingsSection } from "@/components/settings/settings-ui";
import { ProjectTile } from "@/components/shell/sidebar/project-group";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGroupActions } from "@/lib/groups";

/**
 * The group's member projects, and a picker to add one. A project is in at most one group, so
 * the picker says where a project is now: picking it moves it here.
 */
export function GroupMembers({
  group,
  groups,
  projects,
}: {
  group: ProjectGroup;
  groups: ProjectGroup[];
  projects: Project[];
}) {
  const { assign } = useGroupActions();
  const members = projects.filter((p) => p.groupId === group.id);
  const candidates = projects.filter((p) => p.groupId !== group.id);
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name;

  return (
    <SettingsSection
      title="Projects"
      description="Agent sessions of these projects get the group's skills; their PMs and agents read and write its memory."
    >
      {members.length === 0 && (
        <div className="px-4 py-3.5 text-[13px] text-muted-foreground">
          No projects in this group yet.
        </div>
      )}
      {members.map((p) => (
        <div key={p.id} className="flex items-center gap-2.5 px-4 py-2.5">
          <ProjectTile project={p} />
          <Link
            to="/projects/$projectId"
            params={{ projectId: p.id }}
            className="min-w-0 flex-1 truncate text-[13.5px] hover:underline"
          >
            {p.name}
          </Link>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${p.name} from the group`}
            onClick={() => void assign(p.id, null)}
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="px-4 py-3">
        <Select value="" onValueChange={(id) => void assign(id, group.id)}>
          <SelectTrigger
            size="sm"
            className="w-64"
            aria-label="Add a project"
            disabled={candidates.length === 0}
          >
            <SelectValue
              placeholder={candidates.length ? "Add a project" : "Every project is here"}
            />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                {p.groupId && (
                  <span className="ml-1.5 text-muted-foreground">
                    (in {groupName(p.groupId) ?? "another group"})
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingsSection>
  );
}
