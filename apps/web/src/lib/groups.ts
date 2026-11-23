import type { EventEnvelope, GroupMemory, ProjectGroup } from "@codeden/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useClient } from "./api";
import { useSnapshotData } from "./queries";

export const groupMemoryKey = (groupId: string) => ["group-memory", groupId] as const;

/** Refetch an open memory view when anyone, an agent included, writes the group's memory. */
export function invalidateGroupMemory(queryClient: QueryClient, env: EventEnvelope): void {
  if (env.type !== "project_group.memory_written") return;
  void queryClient.invalidateQueries({ queryKey: groupMemoryKey(env.payload.groupId) });
}

export function useGroups(): ProjectGroup[] {
  return useSnapshotData((s) => s.groups, []);
}

export function useGroupMemory(groupId: string) {
  const client = useClient();
  return useQuery<GroupMemory>({
    queryKey: groupMemoryKey(groupId),
    queryFn: () => client.groups.memory(groupId),
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Group changes with an error toast; each resolves to whether it worked. The snapshot follows
 * from the server's events, so nothing is applied here.
 */
export function useGroupActions() {
  const client = useClient();
  return useMemo(() => {
    async function attempt<T>(run: () => Promise<T>, failure: string): Promise<T | null> {
      try {
        return await run();
      } catch (error) {
        toast.error(failure, { description: message(error) });
        return null;
      }
    }
    return {
      create: (req: Parameters<typeof client.groups.create>[0]) =>
        attempt(() => client.groups.create(req), "Couldn't create the group"),
      update: (groupId: string, req: Parameters<typeof client.groups.update>[1]) =>
        attempt(() => client.groups.update(groupId, req), "Couldn't save the group"),
      remove: (group: ProjectGroup) =>
        attempt(() => client.groups.remove(group.id), `Couldn't delete ${group.name}`),
      /** Put a project in a group (moving it out of its old one), or take it out with null. */
      assign: (projectId: string, groupId: string | null) =>
        attempt(
          () => client.updateProject(projectId, { groupId }),
          groupId ? "Couldn't add the project to the group" : "Couldn't remove the project",
        ),
    };
  }, [client]);
}
