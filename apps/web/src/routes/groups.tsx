import { useNavigate } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CreateGroupDialog } from "@/components/groups/create-group-dialog";
import { GroupDetail } from "@/components/groups/group-detail";
import { GroupList } from "@/components/groups/group-list";
import { Button } from "@/components/ui/button";
import { useGroups } from "@/lib/groups";
import { useSnapshotData } from "@/lib/queries";
import { PageHeader } from "./page-header";

/** Project groups: projects that share skills and one memory. `groupId` is the `?group=` pick. */
export function GroupsPage({ groupId }: { groupId: string | null }) {
  const navigate = useNavigate();
  const groups = useGroups();
  const projects = useSnapshotData((s) => s.projects, []);
  const [creating, setCreating] = useState(false);
  // Groups this page has shown: one that is gone from them was deleted, not yet to arrive.
  const seen = useRef(new Set<string>());
  for (const g of groups) seen.current.add(g.id);
  const picked = groups.find((g) => g.id === groupId);
  const deleted = groupId !== null && !picked && seen.current.has(groupId);
  const selected = picked ?? (deleted ? null : (groups[0] ?? null));
  const memberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects)
      if (p.groupId) counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1);
    return counts;
  }, [projects]);
  const select = (id: string | null) =>
    void navigate({ to: "/groups", search: id ? { group: id } : {}, replace: true });

  return (
    <>
      <PageHeader
        icon={<Layers />}
        title="Project groups"
        meta="Projects in a group share skills and one memory"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && !deleted ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
            <Layers className="size-8 text-muted-foreground" />
            <h2 className="text-[15px] font-semibold">No project groups yet</h2>
            <p className="text-[13px] text-muted-foreground">
              Put related projects in a group to give them the same skills and one memory for the
              facts they share.
            </p>
            <Button onClick={() => setCreating(true)}>New group</Button>
            <CreateGroupDialog open={creating} onOpenChange={setCreating} onCreated={select} />
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row">
            <div className="md:w-60 md:shrink-0">
              <GroupList
                groups={groups}
                memberCounts={memberCounts}
                selectedId={selected?.id ?? null}
                onSelect={select}
              />
            </div>
            {selected ? (
              <GroupDetail
                key={selected.id}
                group={selected}
                groups={groups}
                projects={projects}
                onDeleted={() => select(null)}
              />
            ) : (
              <div
                role="status"
                className="flex h-fit max-w-3xl flex-1 flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-[13px]"
              >
                <span className="min-w-0 flex-1">
                  This group was deleted. Its projects are no longer in a group.
                </span>
                {groups.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => select(null)}>
                    Show the other groups
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
