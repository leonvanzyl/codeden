import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type FactoryDigest,
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLoop,
  FactoryTuning,
  LEGACY_SIZE_LIMITS,
  pipelineStep,
  ScoutState,
} from "@codeden/contracts";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { factoryDigests, factoryItems, factoryLoops } from "../../db/schema-factory";
import type { EventStore } from "../../events/store";
import { localDay } from "./policy";

/** A new item: the identifying fields, plus anything else to set. */
export type NewFactoryItem = Pick<
  FactoryItem,
  "projectId" | "workKey" | "title" | "summary" | "source" | "stage"
> &
  Partial<Omit<FactoryItem, "id" | "createdAt" | "updatedAt">>;

/** Stages of items that are still moving through the loop. */
export const ACTIVE_STAGES: FactoryItemStage[] = ["building", "verifying", "watching"];
/** Stages of items waiting to be classified or for a free agent. */
export const WAITING_STAGES: FactoryItemStage[] = ["candidate", "backlog"];
/** Stages whose pull request the loop still owns outside verification (see `owned.ts`). */
export const OWNED_STAGES: FactoryItemStage[] = ["failed", "escalated"];
/** Stages after which an item's sessions have nothing left to do (see `cleanup.ts`). */
export const FINISHED_STAGES: FactoryItemStage[] = ["merged", "reverted", "rejected", "failed"];
/** Final stages. */
export const DONE_STAGES: FactoryItemStage[] = [
  "merged",
  "reverted",
  "rejected",
  "failed",
  "escalated",
];

/**
 * Factory state (§10.1) over the event log: reads come from the `factory_*` projections,
 * writes append `factory.*` events (projected in the same transaction).
 */
export class FactoryStore {
  /** When each project's loop last ticked (see `saveTick`); not persisted. */
  private readonly lastTicks = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly events: EventStore,
  ) {}

  loop(projectId: string): FactoryLoop | undefined {
    const loop = this.db
      .select()
      .from(factoryLoops)
      .where(eq(factoryLoops.projectId, projectId))
      .get()?.loop;
    return loop ? upgradeLoop(loop) : undefined;
  }

  /** The project's loop, or a fresh idle one (not saved). */
  loopOrNew(projectId: string, now = new Date()): FactoryLoop {
    return (
      this.loop(projectId) ?? {
        projectId,
        state: "idle",
        pausedReason: null,
        consecutiveFailures: 0,
        day: localDay(now),
        mergesToday: 0,
        discovery: [],
        nextArea: 0,
        lastDiscoveryAt: null,
        scout: ScoutState.parse({}),
        lastDigestDay: null,
        enabledAt: null,
        seenFailedShas: [],
        tuning: FactoryTuning.parse({}),
        lastTickAt: null,
        updatedAt: now.toISOString(),
      }
    );
  }

  /**
   * Save the loop; writes only when something besides its stamps (`lastTickAt`, `updatedAt`)
   * changed. The log is never pruned (§6) and every loop event refreshes the open factory
   * panels, while an idle factory ticks every 30 s.
   */
  saveLoop(loop: FactoryLoop): FactoryLoop {
    const current = this.loop(loop.projectId);
    if (current && sameLoop(current, loop)) return { ...loop, updatedAt: current.updatedAt };
    const next = { ...loop, updatedAt: new Date().toISOString() };
    this.events.append([
      { type: "factory.loop.updated", sessionId: null, payload: { loop: next } },
    ]);
    return next;
  }

  /**
   * End a tick: remember when it ran and save the loop if the tick changed it. A tick that
   * changed nothing saves nothing, so the time is kept in memory for the panel's "last check".
   */
  saveTick(loop: FactoryLoop, at: string): FactoryLoop {
    this.lastTicks.set(loop.projectId, at);
    return this.saveLoop({ ...loop, lastTickAt: at });
  }

  /** When the project's loop last ticked in this process (none yet after a restart). */
  lastTick(projectId: string): string | undefined {
    return this.lastTicks.get(projectId);
  }

  item(id: string): FactoryItem | undefined {
    const item = this.db.select().from(factoryItems).where(eq(factoryItems.id, id)).get()?.item;
    return item ? withItemDefaults(item) : undefined;
  }

  items(projectId: string, stages?: FactoryItemStage[]): FactoryItem[] {
    const where = stages
      ? and(eq(factoryItems.projectId, projectId), inArray(factoryItems.stage, stages))
      : eq(factoryItems.projectId, projectId);
    return this.db
      .select()
      .from(factoryItems)
      .where(where)
      .orderBy(desc(factoryItems.updatedAt))
      .limit(500)
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /**
   * Items with sessions still to archive (`cleanup.ts`): finished ones not cleaned up yet, and
   * any holding an earlier attempt's sessions. Not capped like `items` (the newest only), so an
   * old item is reached however much work came after it.
   */
  itemsToClean(projectId: string): FactoryItem[] {
    const field = (path: string) => sql`json_extract(${factoryItems.item}, ${path})`;
    const pending = or(
      and(
        inArray(factoryItems.stage, FINISHED_STAGES),
        sql`${field("$.sessionsArchivedAt")} is null`,
      ),
      sql`json_array_length(${field("$.earlierSessionIds")}) > 0`,
    );
    return this.db
      .select()
      .from(factoryItems)
      .where(and(eq(factoryItems.projectId, projectId), pending))
      .orderBy(asc(factoryItems.updatedAt))
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /**
   * Finished items the Factory view may still show (`status.ts` narrows them with
   * `viewRecentItems`): every escalated item; failed items that failed since `failedSince`, still
   * have an open PR, or are rebuilds without a PR of their own (whose original may still be
   * open); and items merged since `mergedSince`. Not capped like `items`, so no amount of newer
   * history hides an unresolved one.
   */
  viewCandidates(projectId: string, failedSince: string, mergedSince: string): FactoryItem[] {
    const field = (path: string) => sql`json_extract(${factoryItems.item}, ${path})`;
    const failed = and(
      eq(factoryItems.stage, "failed"),
      or(
        sql`${field("$.finishedAt")} >= ${failedSince}`,
        sql`${field("$.pr.state")} in ('open', 'draft')`,
        and(sql`${field("$.pr")} is null`, sql`${field("$.rebuiltFrom")} is not null`),
      ),
    );
    const merged = and(
      eq(factoryItems.stage, "merged"),
      sql`${field("$.mergedAt")} >= ${mergedSince}`,
    );
    return this.db
      .select()
      .from(factoryItems)
      .where(
        and(
          eq(factoryItems.projectId, projectId),
          or(eq(factoryItems.stage, "escalated"), failed, merged),
        ),
      )
      .orderBy(desc(factoryItems.updatedAt))
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /** The item a builder, reviewer or revert session works on. */
  itemForSession(projectId: string, sessionId: string): FactoryItem | undefined {
    return this.items(projectId, [...ACTIVE_STAGES, ...WAITING_STAGES]).find(
      (i) => i.builderSessionId === sessionId || i.reviewerSessionId === sessionId,
    );
  }

  /** Create an item; everything not given starts empty. */
  createItem(draft: NewFactoryItem): FactoryItem {
    const now = new Date().toISOString();
    const item: FactoryItem = {
      ...ITEM_DEFAULTS,
      area: null,
      acceptanceCriteria: [],
      score: null,
      issue: null,
      pr: null,
      builderSessionId: null,
      builderProvider: null,
      reviewerSessionId: null,
      reviewerProvider: null,
      reviewerNote: null,
      review: null,
      checks: [],
      attempts: 0,
      reason: null,
      note: null,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      nudges: {},
      largeChange: null,
      mergedAt: null,
      finishedAt: null,
      ...draft,
      id: randomUUID(),
      stepSince: now,
      createdAt: now,
      updatedAt: now,
    };
    this.events.append([{ type: "factory.item.updated", sessionId: null, payload: { item } }]);
    return item;
  }

  /**
   * Apply a change to an item; writes only when something changed. `touch: false` keeps
   * `updatedAt`, for bookkeeping that isn't progress (the digest and the recent list go by it).
   * A change that moves the item to another pipeline step restarts `stepSince`.
   */
  updateItem(
    id: string,
    change: (item: FactoryItem) => FactoryItem,
    opts: { touch?: boolean } = {},
  ): FactoryItem {
    const current = this.item(id);
    if (!current) throw new Error(`No factory item ${id}`);
    const changed = change(current);
    if (JSON.stringify(changed) === JSON.stringify(current)) return current;
    const now = new Date().toISOString();
    const stepped =
      pipelineStep(changed) === pipelineStep(current) ? changed : { ...changed, stepSince: now };
    const next = opts.touch === false ? stepped : { ...stepped, updatedAt: now };
    this.events.append([
      { type: "factory.item.updated", sessionId: null, payload: { item: next } },
    ]);
    return next;
  }

  digests(projectId: string, limit = 10): FactoryDigest[] {
    return this.db
      .select()
      .from(factoryDigests)
      .where(eq(factoryDigests.projectId, projectId))
      .orderBy(desc(factoryDigests.createdAt))
      .limit(limit)
      .all()
      .map((r) => r.digest);
  }

  saveDigest(digest: FactoryDigest): void {
    this.events.append([{ type: "factory.digest.created", sessionId: null, payload: { digest } }]);
  }
}

/** Fields items saved before 0.6 lack (the projection keeps the JSON as it was written). */
const ITEM_DEFAULTS = {
  type: null,
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  failureKind: null,
  rebuiltFrom: null,
  stepSince: null,
} satisfies Partial<FactoryItem>;

/** An item as read from the projection, with the fields newer versions added. */
export function withItemDefaults(item: FactoryItem): FactoryItem {
  return { ...ITEM_DEFAULTS, ...item };
}

/** Same loop apart from the stamps a save sets; key order and `undefined` fields don't count. */
function sameLoop(a: FactoryLoop, b: FactoryLoop): boolean {
  const content = ({ lastTickAt: _tick, updatedAt: _saved, ...rest }: FactoryLoop) =>
    JSON.parse(JSON.stringify(rest)) as unknown;
  return isDeepStrictEqual(content(a), content(b));
}

const TUNING_DEFAULTS = FactoryTuning.parse({});

/** A loop as read from the projection: newer tuning knobs and the scout filled in. */
export function upgradeLoop(loop: FactoryLoop): FactoryLoop {
  return upgradeSizeLimits({
    ...loop,
    discovery: loop.discovery ?? [],
    scout: ScoutState.parse(loop.scout ?? {}),
    tuning: { ...TUNING_DEFAULTS, ...loop.tuning },
  });
}

/**
 * Loops saved before 0.4.4 carry the old default size limits (800 lines, 40 files, counting
 * lockfiles and generated files), which blocked ordinary scaffolds. Untouched old defaults
 * become the current defaults; limits someone chose are kept.
 */
export function upgradeSizeLimits(loop: FactoryLoop): FactoryLoop {
  const t = loop.tuning;
  if (
    t.maxChangedLines !== LEGACY_SIZE_LIMITS.maxChangedLines ||
    t.maxChangedFiles !== LEGACY_SIZE_LIMITS.maxChangedFiles
  ) {
    return loop;
  }
  const defaults = FactoryTuning.parse({});
  return {
    ...loop,
    tuning: {
      ...t,
      maxChangedLines: defaults.maxChangedLines,
      maxChangedFiles: defaults.maxChangedFiles,
    },
  };
}
