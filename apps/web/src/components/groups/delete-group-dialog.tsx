import type { ProjectGroup } from "@codeden/contracts";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useGroupActions } from "@/lib/groups";

export function DeleteGroupDialog({
  group,
  memberCount,
  open,
  onOpenChange,
  onDeleted,
}: {
  group: ProjectGroup;
  memberCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { remove } = useGroupActions();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {memberCount > 0
              ? `Its ${memberCount} member ${memberCount === 1 ? "project is" : "projects are"} taken out of the group, `
              : "Nobody is in the group. "}
            its skills stop reaching new sessions, and its shared memory is deleted. The projects
            themselves stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              const done = await remove(group);
              setBusy(false);
              if (!done) return;
              onOpenChange(false);
              onDeleted();
            }}
          >
            Delete group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
