import { type EventOf, nextMemoryContent, ProjectGroup } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import { projectGroupMemory, projectGroups, projects } from "../../db/schema";
import type { Tx } from "../../events/projection-db";

type GroupEvent = EventOf<
  "project_group.saved" | "project_group.deleted" | "project_group.memory_written"
>;

/** Project groups (DESIGN.md "Project groups"), inside the append transaction (§6). */
export function applyGroupProjection(tx: Tx, e: GroupEvent): void {
  switch (e.type) {
    case "project_group.saved": {
      const row = e.payload.group;
      tx.insert(projectGroups)
        .values(row)
        .onConflictDoUpdate({ target: projectGroups.id, set: row })
        .run();
      return;
    }
    case "project_group.deleted": {
      const { groupId } = e.payload;
      tx.delete(projectGroups).where(eq(projectGroups.id, groupId)).run();
      tx.delete(projectGroupMemory).where(eq(projectGroupMemory.groupId, groupId)).run();
      // Members were taken out by their own `project.updated`; this only covers a log that has
      // none (an archived project the delete did not list).
      tx.update(projects).set({ groupId: null }).where(eq(projects.groupId, groupId)).run();
      return;
    }
    case "project_group.memory_written": {
      const { groupId, mode, content, revision } = e.payload;
      const current = tx
        .select({ content: projectGroupMemory.content })
        .from(projectGroupMemory)
        .where(eq(projectGroupMemory.groupId, groupId))
        .get();
      const row = {
        groupId,
        content: nextMemoryContent(current?.content ?? "", content, mode),
        revision,
        updatedAt: e.ts,
      };
      tx.insert(projectGroupMemory)
        .values(row)
        .onConflictDoUpdate({ target: projectGroupMemory.groupId, set: row })
        .run();
      return;
    }
  }
}

/** A group row as the entity. */
export function rowToGroup(row: typeof projectGroups.$inferSelect): ProjectGroup {
  return ProjectGroup.parse(row);
}
