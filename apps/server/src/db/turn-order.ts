import { asc, desc, sql } from "drizzle-orm";
import { turns } from "./schema";

// Turn ids are random (UUIDs), so the primary key order says nothing about time: list turns by
// when they started, then by insertion (rowid; upserts keep it) for turns started in the same
// append, which share a timestamp. For queries on `turns` alone (`rowid` is unqualified).

/** `orderBy` terms for a session's turns, oldest first. */
export const turnsOldestFirst = [asc(turns.startedAt), asc(sql`rowid`)];

/** `orderBy` terms for a session's turns, newest first. */
export const turnsNewestFirst = [desc(turns.startedAt), desc(sql`rowid`)];
