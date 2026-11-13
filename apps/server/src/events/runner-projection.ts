import { type EventOf, HOME_RUNNER_ID, type RunnerRecord } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { runners } from "../db/schema";
import type { Tx } from "./projection-db";

type RunnerEvent = EventOf<
  "runner.registered" | "runner.deleted" | "runner.connected" | "runner.disconnected"
>;
type RunnerRow = typeof runners.$inferSelect;

/**
 * Projection of runner lifecycle events into `runners` (`docs/remote-runners.md` §8). Events
 * without a record id were stored before several runners existed and belong to the home
 * runner. `lastSeenAt` moves only on connect and disconnect, never per agent event.
 */
export function applyRunnerProjection(tx: Tx, e: RunnerEvent): void {
  switch (e.type) {
    case "runner.registered": {
      const row = runnerToRow(e.payload.runner);
      tx.insert(runners).values(row).onConflictDoUpdate({ target: runners.id, set: row }).run();
      return;
    }
    case "runner.deleted":
      tx.update(runners).set({ state: "deleted" }).where(eq(runners.id, e.payload.id)).run();
      return;
    case "runner.connected": {
      const { runnerId, version } = e.payload;
      tx.update(runners)
        .set({ state: "connected", runnerId, version, lastSeenAt: e.ts, lastError: null })
        .where(eq(runners.id, e.payload.id ?? HOME_RUNNER_ID))
        .run();
      return;
    }
    case "runner.disconnected":
      tx.update(runners)
        .set({ state: "disconnected", lastSeenAt: e.ts, lastError: e.payload.reason })
        .where(eq(runners.id, e.payload.id ?? HOME_RUNNER_ID))
        .run();
      return;
  }
}

export function runnerToRow(r: RunnerRecord): RunnerRow {
  return {
    id: r.id,
    backend: r.backend,
    isHome: r.home,
    runnerId: r.runnerId,
    sandboxRef: r.sandboxRef,
    projectId: r.projectId,
    sessionId: r.sessionId,
    state: r.state,
    version: r.version,
    imageVersion: r.imageVersion,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
  };
}

export function rowToRunner(row: RunnerRow): RunnerRecord {
  return {
    id: row.id,
    backend: row.backend,
    home: row.isHome,
    runnerId: row.runnerId,
    sandboxRef: row.sandboxRef,
    projectId: row.projectId,
    sessionId: row.sessionId,
    state: row.state,
    version: row.version,
    imageVersion: row.imageVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
  };
}

/** One stored runner record, or undefined. */
export function findRunnerRecord(db: Db, id: string): RunnerRecord | undefined {
  const row = db.select().from(runners).where(eq(runners.id, id)).get();
  return row ? rowToRunner(row) : undefined;
}

/**
 * The record of the runner with this journal id, if any. When several records carry it (a
 * sandbox re-provisioned from the same image), a live one wins over a deleted one.
 */
export function findRunnerByRunnerId(db: Db, runnerId: string): RunnerRecord | undefined {
  const rows = db.select().from(runners).where(eq(runners.runnerId, runnerId)).all();
  const row = rows.find((r) => r.state !== "deleted") ?? rows[0];
  return row ? rowToRunner(row) : undefined;
}

/** Every stored runner record, the home runner first. */
export function listRunnerRecords(db: Db): RunnerRecord[] {
  return db
    .select()
    .from(runners)
    .all()
    .map(rowToRunner)
    .sort((a, b) => Number(b.home) - Number(a.home) || a.createdAt.localeCompare(b.createdAt));
}
