/**
 * The full SQLite schema (§6): one barrel over every `schema-*.ts` file. drizzle-kit reads the
 * `schema-*.ts` files directly (drizzle.config.ts); the app imports tables from here, and
 * `test/schema-barrel.test.ts` keeps this list complete.
 */
export * from "./schema-automations";
export * from "./schema-core";
export * from "./schema-factory";
export * from "./schema-github";
export * from "./schema-orchestration";
export * from "./schema-search";
export * from "./schema-usage";
