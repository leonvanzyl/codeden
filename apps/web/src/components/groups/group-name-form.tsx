import type { ProjectGroup } from "@codeden/contracts";
import { useState } from "react";
import { SettingRow, SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useGroupActions } from "@/lib/groups";

/** Rename a group and edit its description; Save is enabled once something changed. */
export function GroupNameForm({ group }: { group: ProjectGroup }) {
  const { update } = useGroupActions();
  const saved = { name: group.name, description: group.description ?? "" };
  const [name, setName] = useState(saved.name);
  const [description, setDescription] = useState(saved.description);
  const [base, setBase] = useState(saved);
  const [busy, setBusy] = useState(false);
  // A change saved elsewhere (another tab, the orchestrator) replaces the fields not being edited.
  if (saved.name !== base.name || saved.description !== base.description) {
    if (name === base.name) setName(saved.name);
    if (description === base.description) setDescription(saved.description);
    setBase(saved);
  }
  const dirty = name.trim() !== group.name || description.trim() !== (group.description ?? "");

  async function save() {
    setBusy(true);
    await update(group.id, { name, description: description.trim() || null });
    setBusy(false);
  }

  return (
    <SettingsSection title="Group">
      <SettingRow label="Name" stacked>
        <Input
          aria-label="Group name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </SettingRow>
      <SettingRow label="Description" stacked>
        <Textarea
          aria-label="Description"
          value={description}
          rows={2}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!dirty || !name.trim() || busy} onClick={save}>
            Save
          </Button>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
