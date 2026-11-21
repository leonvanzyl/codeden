import { type FormEvent, useState } from "react";
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
import { useGroupActions } from "@/lib/groups";

export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (groupId: string) => void;
}) {
  const { create } = useGroupActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const group = await create({ name, description: description.trim() || null });
    setBusy(false);
    if (!group) return;
    setName("");
    setDescription("");
    onOpenChange(false);
    onCreated(group.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New project group</DialogTitle>
            <DialogDescription>
              Projects in a group share skills and one memory. Add the projects after you create it.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Group name"
            placeholder="Name"
            value={name}
            maxLength={100}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <Textarea
            aria-label="Description"
            placeholder="Description (optional)"
            value={description}
            maxLength={2000}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
