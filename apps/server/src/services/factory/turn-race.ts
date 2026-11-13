import type { FactoryItem, FactoryLoop, InboxItem, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import {
  isTransientRunnerError,
  isTurnRunningError,
  TURN_RUNNING_TEXT,
} from "../sessions/outbox-holds";
import type { FactoryContext } from "./context";
import { freeSlots } from "./policy";
import { BUILDER_RESUME } from "./prompts";
import { isBusy } from "./sessions";

/**
 * Builders hit by a message racing their turn. Before the session service queued such a
 * message, the provider's "A turn is already running" marked the session failed while the
 * agent kept working, and the building step then failed the item. Such a builder is told to
 * carry on instead (once per failure), and items that failed that way go back to building.
 * Telling a builder to carry on starts an agent turn, so it waits for a free agent under
 * `maxConcurrentSessions` and for a loop that isn't paused, like starting new work. The turn
 * starts then or not at all (`FactorySessions.startTurn` never queues): until it has started,
 * nothing is recorded and the next tick tries again through the same checks.
 */

/** Why the building step failed an item whose builder session failed (`progress.ts`). */
export const BUILDER_FAILED_REASON = "The builder session failed without a pull request";

/** Nudge key prefix: one "carry on" per run failure (its inbox item id follows). */
const TOLD_PREFIX = "turn_race:";
/**
 * Nudge key prefix of a recovery in progress: the item is back in building while its builder
 * starts. It stays only if the server stopped mid-way, so the building step can finish it.
 */
const RECOVERING_PREFIX = "turn_race_recovering:";

const INBOX_STATUSES = ["open", "resolved", "dismissed"] as const;

const WAITING_NOTE =
  "Its builder was marked failed by a message that raced its turn: it carries on when an agent is free";
const RETRY_NOTE =
  "Its builder was marked failed by a message that raced its turn: telling it to carry on again next tick";

/** The session's latest run failure, when a message racing its running turn caused it. */
export function turnRaceFailure(ctx: FactoryContext, session: Session): InboxItem | undefined {
  const latest = INBOX_STATUSES.flatMap((status) =>
    ctx.inbox.list({ sessionId: session.id, status }),
  )
    .filter((i) => i.kind === "run_failed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest?.body && TURN_RUNNING_TEXT.test(latest.body) ? latest : undefined;
}

/** Whether a builder may be told to carry on now: the loop runs and an agent is free. */
function mayResume(ctx: FactoryContext, project: Project, loop: FactoryLoop): boolean {
  if (loop.state === "paused") return false;
  return freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) > 0;
}

/**
 * For a builder that failed or stopped: whether the item waits instead of failing. A builder
 * that failed because of a turn race is told to carry on once an agent is free, and the item
 * waits until the session has moved on since. A stopped one is only resumed when the recovery
 * below was bringing it back and the server stopped mid-way: the building step never restarts
 * a session someone stopped.
 */
export async function awaitTurnRaceResume(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  s: Session,
): Promise<boolean> {
  const failure = turnRaceFailure(ctx, s);
  if (!failure) return false;
  const asked = item.nudges[TOLD_PREFIX + failure.id];
  if (asked) return Date.parse(s.updatedAt) <= Date.parse(asked);
  if (s.status !== "failed" && !item.nudges[RECOVERING_PREFIX + failure.id]) return false;
  if (!mayResume(ctx, project, loop)) {
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: WAITING_NOTE }), { touch: false });
    return true;
  }
  // Not started for now (runner away, a turn running): the item waits for the next tick. One
  // that can't be started at all fails like any other dead builder.
  return (await resumeBuilder(ctx, item, s, failure)) !== "gave_up";
}

/**
 * Items that failed because their builder lost a message race go back to building, oldest
 * first. A builder that is busy or opened its pull request meanwhile needs no agent and is left
 * to the building step. Any other is told to carry on, which also brings an archived builder
 * and its worktree back, but only while an agent is free.
 *
 * The item is back in building before that turn starts: the builder's factory tools
 * (`factory_report_reproduction`, `factory_submit_analysis`) are offered only to the builder of
 * an item in building, its provider lists them once, while it opens, and its reports need the
 * item there. If the turn doesn't start, the item goes back to exactly how it was (failed, and
 * recoverable on a later tick), unless a report moved it on meanwhile.
 */
export async function recoverTurnRaceFailures(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<void> {
  const failed = ctx.store
    .items(project.id, ["failed"])
    .filter((i) => i.reason === BUILDER_FAILED_REASON && i.builderSessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const item of failed) {
    const s = ctx.repo.find(item.builderSessionId as string)?.session;
    if (!s) continue;
    const failure = turnRaceFailure(ctx, s);
    // Told to carry on once already: a failure after that is real.
    if (!failure || item.nudges[TOLD_PREFIX + failure.id]) continue;
    const pr = s.pr ?? ctx.github.prForSession(project.id, s.id, s.branch);
    const needsAgent = !isBusy(s) && !(pr && pr.state !== "closed" && pr.state !== "merged");
    if (!needsAgent) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, ...REOPEN }));
      ctx.log?.(`factory: ${item.id}: back to building after a message raced its builder's turn`);
      continue;
    }
    if (!mayResume(ctx, project, loop)) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, note: WAITING_NOTE }), { touch: false });
      continue;
    }
    const recovering = RECOVERING_PREFIX + failure.id;
    const reopened = ctx.store.updateItem(
      item.id,
      (i) => ({ ...i, ...REOPEN, nudges: { ...i.nudges, [recovering]: ctx.now().toISOString() } }),
      { touch: false },
    );
    if ((await resumeBuilder(ctx, reopened, s, failure)) === "started") {
      ctx.log?.(`factory: ${item.id}: back to building after a message raced its builder's turn`);
      continue;
    }
    ctx.store.updateItem(
      item.id,
      (i) =>
        i.stage !== "building" || i.builderSessionId !== s.id
          ? i
          : {
              ...i,
              stage: "failed",
              reason: item.reason,
              finishedAt: item.finishedAt,
              sessionsArchivedAt: item.sessionsArchivedAt,
              nudges: without(i.nudges, recovering),
            },
      { touch: false },
    );
  }
}

/**
 * Whether this step owns the failed item: its builder failed because a message raced its turn,
 * and it wasn't told to carry on yet. The general infrastructure recovery (`recover.ts`) leaves
 * such items to it.
 */
export function ownsTurnRaceFailure(ctx: FactoryContext, item: FactoryItem): boolean {
  if (item.reason !== BUILDER_FAILED_REASON || !item.builderSessionId) return false;
  const s = ctx.repo.find(item.builderSessionId)?.session;
  const failure = s ? turnRaceFailure(ctx, s) : undefined;
  return failure !== undefined && !item.nudges[TOLD_PREFIX + failure.id];
}

/** What going back to building changes on a recovered item. */
const REOPEN = {
  stage: "building",
  reason: null,
  failureKind: null,
  note: "Back to building: its builder was marked failed by a message that raced its turn",
  finishedAt: null,
  sessionsArchivedAt: null,
} as const;

function without(nudges: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _gone, ...rest } = nudges;
  return rest;
}

/**
 * Tell the builder to carry on, starting its turn now (which also brings an archived builder
 * and its worktree back). The time is taken before sending, so a turn that fails at once is a
 * new failure.
 * - `started`: recorded as told.
 * - `retry`: the runner was away or slow, or a turn is running; nothing is recorded, so the
 *   next tick tries again through the same agent limit.
 * - `gave_up`: it can't be started (an error that isn't passing); recorded as told, so the
 *   item fails or stays failed like any other with a dead builder.
 */
async function resumeBuilder(
  ctx: FactoryContext,
  item: FactoryItem,
  s: Session,
  failure: InboxItem,
): Promise<"started" | "retry" | "gave_up"> {
  const at = ctx.now().toISOString();
  const told = (i: FactoryItem) => ({
    ...without(i.nudges, RECOVERING_PREFIX + failure.id),
    [TOLD_PREFIX + failure.id]: at,
  });
  try {
    await ctx.sessions.startTurn(s.id, BUILDER_RESUME);
  } catch (error) {
    const why = errorMessage(error);
    ctx.log?.(`factory: ${item.id}: could not tell the builder to carry on: ${why}`);
    if (isTransientRunnerError(error) || isTurnRunningError(error)) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, note: `${RETRY_NOTE} (${why})` }), {
        touch: false,
      });
      return "retry";
    }
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Could not tell its builder to carry on: ${why}`,
      nudges: told(i),
    }));
    return "gave_up";
  }
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: "Its builder was marked failed by a message that raced its turn: told to carry on",
    nudges: told(i),
  }));
  return "started";
}
