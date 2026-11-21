import type { Project, ProjectGroup } from "@codeden/contracts";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { GroupMembers } from "./group-members";
import { GroupMemory } from "./group-memory";
import { GroupNameForm } from "./group-name-form";
import { GroupSkills } from "./group-skills";

/** One group: its name, projects, skills and memory, and Delete. */
export function GroupDetail({
  group,
  groups,
  projects,
  onDeleted,
}: {
  group: ProjectGroup;
  groups: ProjectGroup[];
  projects: Project[];
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const memberCount = projects.filter((p) => p.groupId === group.id).length;
  return (
    <div className="min-w-0 max-w-3xl flex-1">
      <GroupNameForm group={group} />
      <GroupMembers group={group} groups={groups} projects={projects} />
      <GroupSkills group={group} />
      <GroupMemory groupId={group.id} />
      <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
        <Trash2 /> Delete group
      </Button>
      <DeleteGroupDialog
        group={group}
        memberCount={memberCount}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={onDeleted}
      />
    </div>
  );
}
