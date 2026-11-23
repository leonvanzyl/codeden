import type { GroupSkill, ProjectGroup } from "@codeden/contracts";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { useGroupActions } from "@/lib/groups";
import { SkillDialog } from "./skill-dialog";

/**
 * The group's skills. Every change saves the whole list, the way the server takes it, built from
 * the list as it is when saving and keyed by name, so a change made elsewhere meanwhile is kept.
 */
export function GroupSkills({ group }: { group: ProjectGroup }) {
  const { update } = useGroupActions();
  // The skill being edited by its name when the dialog opened; null is a new one.
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const skills = group.skills;

  const saveAll = async (next: GroupSkill[]) => (await update(group.id, { skills: next })) !== null;

  async function save(skill: GroupSkill, original: string | null) {
    const exists = original !== null && skills.some((s) => s.name === original);
    const next = exists ? skills.map((s) => (s.name === original ? skill : s)) : [...skills, skill];
    return saveAll(next);
  }

  return (
    <SettingsSection
      title="Skills"
      description="Every agent session of a member project gets these as native skills. A project's own skill with the same name wins."
    >
      {skills.length === 0 && (
        <div className="px-4 py-3.5 text-[13px] text-muted-foreground">No skills yet.</div>
      )}
      {skills.map((s) => (
        <div key={s.name} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px]">{s.name}</div>
            <div className="truncate text-2xs text-muted-foreground">{s.description}</div>
          </div>
          {confirming === s.name ? (
            <>
              <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => {
                  setConfirming(null);
                  void saveAll(skills.filter((k) => k.name !== s.name));
                }}
              >
                Delete {s.name}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit ${s.name}`}
                onClick={() => setEditing({ name: s.name })}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${s.name}`}
                onClick={() => setConfirming(s.name)}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      ))}
      <div className="px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => setEditing({ name: null })}>
          <Plus /> Add skill
        </Button>
      </div>
      {editing && (
        <SkillDialog
          key={editing.name ?? ""}
          skill={skills.find((s) => s.name === editing.name) ?? null}
          others={skills.filter((s) => s.name !== editing.name).map((s) => s.name)}
          onSave={(skill) => save(skill, editing.name)}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}
