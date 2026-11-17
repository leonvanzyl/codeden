import type { FactoryItem, FactoryLoop, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { startWentUnanswered, unansweredStartAt } from "../sessions/unanswered-start";
import { untilText } from "./availability";
import type { FactoryContext } from "./context";
import { recheckOf } from "./recheck";
import { isBusy, REVIEW_WORK_KEY_PREFIX } from "./sessions";
import { ACTIVE_STAGES, OWNED_STAGES, WAITING_STAGES } from "./store";
import { BUILDER_FAILED_REASON } from "./turn-race";

/**
 * Starts the runner left unanswered (§10.1, issue #492). Under load, `session.start` can time
 * out on the runner, or its connection drop mid-start, while the provider session opens anyway
 * a little later; until its events bring it back, the session reads as failed. A busy runner is
 * no failure of the provider: nothing backs it off (`provider-failure.ts`). The factory waits
 * `START_ANSWER_GRACE_MS` for such a session to show it started before it treats it as a session
 * that died (a reviewer is replaced, a builder's item fails as an infrastructure failure and the
 * loop puts it back). One that starts after that is adopted when its work still waits for it
 * (an item with no reviewer, a builder's failed item), and otherwise stopped and archived, so two
 * agents never do one job and only one verdict counts.
 */

/** How long the factory waits for a session whose start the runner didn't answer. */
export const START_ANSWER_GRACE_MS = 5 * 60_000;

/**
 * Until when the factory waits for `s` to show it started, while all that is known is that the
 * runner left its start unanswered; null when it doesn't wait (any more).
 */
export function awaitingStart(ctx: FactoryContext, s: Session): string | null {
  const at = unansweredStartAt(ctx.repo, s);
  if (!at) return null;
  const until = Date.parse(at) + START_ANSWER_GRACE_MS;
  return ctx.now().getTime() < until ? new Date(until).toISOString() : null;
}

/** The item's note while it waits for its builder's, reviewer's or integrator's unanswered start. */
export function awaitingStartNote(
  role: "builder" | "reviewer" | "integrator",
  until: string,
): string {
  return `The runner was too busy to answer the ${role}'s start: waiting${untilText(until)} to see whether it started`;
}

const ADOPTED_REVIEWER =
  "The reviewer started after all (the runner was slow to answer its start): it carries on";
const ADOPTED_BUILDER =
  "Back to building: its builder started after all (the runner was slow to answer its start)";

/**
 * Factory sessions whose start the runner left unanswered and which started after the factory
 * stopped waiting for them (a turn has run, and they didn't fail or stop again). Each is adopted
 * or retired (see the module); sessions the factory still uses are left alone.
 */
export async function settleLateStarts(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<void> {
  const items = ctx.store.items(project.id, [...WAITING_STAGES, ...ACTIVE_STAGES, ...OWNED_STAGES]);
  const inUse = new Set<string>();
  /** Builders whose item failed because they didn't start, by session id. */
  const lostBuilders = new Map<string, FactoryItem>();
  for (const i of items) {
    if (i.reviewerSessionId) inUse.add(i.reviewerSessionId);
    if (!i.builderSessionId) continue;
    if (i.stage === "failed" && i.reason === BUILDER_FAILED_REASON) {
      lostBuilders.set(i.builderSessionId, i);
    } else {
      inUse.add(i.builderSessionId);
    }
  }
  if (loop.scout.sessionId) inUse.add(loop.scout.sessionId);
  for (const id of Object.values(loop.scout.lensSessions)) if (id) inUse.add(id);
  const late = ctx.sessions
    .list(project.id)
    .filter(
      (s) =>
        !inUse.has(s.id) &&
        s.status !== "failed" &&
        s.status !== "stopped" &&
        (!s.archivedAt || isBusy(s)) &&
        startWentUnanswered(ctx.repo, s.id) &&
        ctx.repo.rootTurnIds(s).length > 0,
    );
  for (const s of late) {
    try {
      await settleOne(ctx, items, lostBuilders.get(s.id), s);
    } catch (error) {
      ctx.log?.(`factory: session ${s.id} started late: ${errorMessage(error)}`);
    }
  }
}

async function settleOne(
  ctx: FactoryContext,
  items: FactoryItem[],
  lostBuilderOf: FactoryItem | undefined,
  s: Session,
): Promise<void> {
  if (lostBuilderOf && !s.archivedAt) {
    ctx.store.updateItem(lostBuilderOf.id, (i) =>
      i.stage !== "failed" || i.builderSessionId !== s.id
        ? i
        : {
            ...i,
            stage: "building",
            reason: null,
            failureKind: null,
            finishedAt: null,
            sessionsArchivedAt: null,
            note: ADOPTED_BUILDER,
          },
    );
    ctx.log?.(`factory: ${lostBuilderOf.id}: its builder ${s.id} started late; back to building`);
    return;
  }
  const reviewing = s.workKey.startsWith(REVIEW_WORK_KEY_PREFIX)
    ? items.find((i) => i.earlierSessionIds.includes(s.id))
    : undefined;
  // Read again: an earlier late reviewer of the same item may have been adopted just now.
  const current = reviewing ? ctx.store.item(reviewing.id) : undefined;
  if (current && !s.archivedAt && wantsReviewer(current)) {
    ctx.store.updateItem(current.id, (i) => {
      if (!wantsReviewer(i)) return i;
      // A nudge for a verdict went to an earlier reviewer, not to this one.
      const { reviewer: _nudged, ...nudges } = i.nudges;
      return {
        ...i,
        reviewerSessionId: s.id,
        reviewerProvider: s.provider,
        earlierSessionIds: i.earlierSessionIds.filter((id) => id !== s.id),
        note: ADOPTED_REVIEWER,
        nudges,
      };
    });
    ctx.log?.(`factory: ${current.id}: its reviewer ${s.id} started late and is adopted`);
    return;
  }
  // Another session took its place, or its work is over: one job, one agent.
  ctx.log?.(`factory: session ${s.id} started late after it was replaced; stopping it`);
  if (isBusy(s)) await ctx.sessions.stop(s.id);
  ctx.archiveSessions([s.id]);
}

/** The item is in verification without a reviewer, and still owes a review or a re-check. */
function wantsReviewer(item: FactoryItem): boolean {
  if (item.stage !== "verifying" || item.reviewerSessionId) return false;
  return !item.review || recheckOf(item) !== null;
}
