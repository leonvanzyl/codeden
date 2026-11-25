import type { TechDebtView } from "@codeden/contracts";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectTechDebt = sqliteTable("project_tech_debt", {
  projectId: text("project_id").primaryKey(),
  view: text("view", { mode: "json" }).$type<TechDebtView>().notNull(),
});
