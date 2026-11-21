import type { GroupSkill } from "@codeden/contracts";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Project groups (DESIGN.md "Project groups"): projections of the `project_group.*` events. A
 * project's group is `projects.group_id`.
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const projectGroups = sqliteTable("project_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  skills: json<GroupSkill[]>("skills").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A group's shared memory, one row per group once it was first written. */
export const projectGroupMemory = sqliteTable("project_group_memory", {
  groupId: text("group_id").primaryKey(),
  content: text("content").notNull(),
  /** Writes so far (`GroupMemory.revision`). */
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});
