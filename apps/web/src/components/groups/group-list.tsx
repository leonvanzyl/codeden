import type { ProjectGroup } from "@codeden/contracts";
import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CreateGroupDialog } from "./create-group-dialog";

/** The groups, one button each, with the member count; New group opens the create dialog. */
export function GroupList({
  groups,
  memberCounts,
  selectedId,
  onSelect,
}: {
  groups: ProjectGroup[];
  memberCounts: Map<string, number>;
  selectedId: string | null;
  onSelect: (groupId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <nav aria-label="Project groups" className="flex flex-col gap-1">
      {groups.map((g) => {
        const count = memberCounts.get(g.id) ?? 0;
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            aria-current={g.id === selectedId ? "true" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-muted",
              g.id === selectedId && "bg-muted font-medium",
            )}
          >
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{g.name}</span>
            <span className="text-2xs text-muted-foreground">
              {count} {count === 1 ? "project" : "projects"}
            </span>
          </button>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="mt-1 self-start"
        onClick={() => setCreating(true)}
      >
        <Plus /> New group
      </Button>
      <CreateGroupDialog open={creating} onOpenChange={setCreating} onCreated={onSelect} />
    </nav>
  );
}
