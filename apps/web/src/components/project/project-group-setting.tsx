import type { Project } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { SettingRow, SettingsSection } from "@/components/settings/settings-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGroupActions, useGroups } from "@/lib/groups";

const NONE = "none";

/** Project page > Settings: the group this project belongs to (at most one). */
export function ProjectGroupSetting({ project }: { project: Project }) {
  const groups = useGroups();
  const { assign } = useGroupActions();
  const group = groups.find((g) => g.id === project.groupId);
  return (
    <SettingsSection
      title="Project group"
      description="Projects in a group share skills and one memory."
    >
      <SettingRow
        label="Group"
        help={
          group ? (
            <Link
              to="/groups"
              search={{ group: group.id }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Open {group.name} in Project groups
            </Link>
          ) : (
            <>
              Not in a group.{" "}
              <Link to="/groups" className="underline underline-offset-2 hover:text-foreground">
                Manage project groups
              </Link>
            </>
          )
        }
      >
        <Select
          value={group?.id ?? NONE}
          onValueChange={(v) => void assign(project.id, v === NONE ? null : v)}
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Project group">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsSection>
  );
}
