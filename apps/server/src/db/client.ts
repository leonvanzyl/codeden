import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { backfillSearchIndex } from "../services/search/index-writer";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDrizzle>;

function createDrizzle(client: DatabaseSync) {
  return drizzle({ client });
}

/** Locate the drizzle migrations folder in dev (`apps/server/drizzle`) or a bundle (`dist/drizzle`). */
export function findMigrationsDir(explicit?: string): string {
  const here = import.meta.dirname;
  const candidates = [
    explicit,
    resolve(here, "../../drizzle"),
    resolve(here, "drizzle"),
    resolve(here, "../drizzle"),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Drizzle migrations not found (looked in ${candidates.join(", ")})`);
  return found;
}

export interface Database {
  db: Db;
  client: DatabaseSync;
  close(): void;
}

/**
 * Open (or create) the SQLite database in WAL mode, apply pending migrations and index any
 * transcript items stored before transcript search existed.
 */
export function openDatabase(file: string, migrationsDir?: string): Database {
  const client = new DatabaseSync(file);
  client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA synchronous = NORMAL;");
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec("PRAGMA busy_timeout = 5000;");
  const db = createDrizzle(client);
  migrate(db, { migrationsFolder: findMigrationsDir(migrationsDir) });
  backfillSearchIndex(db);
  return {
    db,
    client,
    close: () => {
      if (client.isOpen) client.close();
    },
  };
}

export { schema };
