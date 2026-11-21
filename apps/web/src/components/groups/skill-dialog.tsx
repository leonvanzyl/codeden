import type { GroupSkill } from "@codeden/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { hasErrors, skillErrors } from "@/lib/group-skills";

const EMPTY: GroupSkill = { name: "", description: "", body: "" };

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {error && <span className="block text-2xs text-destructive">{error}</span>}
    </div>
  );
}

/** Add or edit one skill. Problems show once the user has tried to save. */
export function SkillDialog({
  skill,
  others,
  onSave,
  onClose,
}: {
  skill: GroupSkill | null;
  /** The group's other skills' names. */
  others: readonly string[];
  onSave: (skill: GroupSkill) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<GroupSkill>(skill ?? EMPTY);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = skillErrors(draft, others);
  const shown = tried ? errors : {};
  const set = (patch: Partial<GroupSkill>) => setDraft({ ...draft, ...patch });

  async function submit() {
    setTried(true);
    if (hasErrors(errors)) return;
    setBusy(true);
    const saved = await onSave(draft);
    setBusy(false);
    if (saved) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? `Edit ${skill.name}` : "New skill"}</DialogTitle>
          <DialogDescription>
            The name is the skill's folder; the description tells the agent when to use it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name" error={shown.name}>
            <Input
              aria-label="Name"
              value={draft.name}
              maxLength={64}
              placeholder="release-notes"
              className="font-mono"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Description" error={shown.description}>
            <Textarea
              aria-label="Description"
              value={draft.description}
              rows={2}
              maxLength={1024}
              placeholder="Use when writing release notes for a version"
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field label="Instructions (Markdown)" error={shown.body}>
            <Textarea
              aria-label="Instructions"
              value={draft.body}
              rows={12}
              className="font-mono text-[13px]"
              onChange={(e) => set({ body: e.target.value })}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            Save skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
