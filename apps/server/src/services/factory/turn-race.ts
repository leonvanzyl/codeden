import type { FactoryItem, InboxItem, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { TURN_RUNNING_TEXT } from "../sessions/outbox-holds";
import type { FactoryContext } from "./context";
import { BUILDER_RESUME } from "./prompts";
import { isBusy } from "./sessions";

/**
 * Builders hit by a message racing their turn. Before the session service queued such a
 * message, the provider's "A turn is already running" marked the session failed while the
 * agent kept working, and the building step then failed the item. Such a builder is told to
 * carry on instead (once per failure), and items that failed that way go back to building.
 */

/** Why the building step failed an item whose builder session failed (`progress.ts`). */
export const BUILDER_FAILED_REASON = "The builder session failed without a pull request";

/** Nudge key prefix: one "carry on" per run failure (its inbox item id follows). */
const NUDGE_PREFIX = "turn_race:";

const INBOX_STATUSES = ["open", "resolved", "dismissed"] as const;

/** The session's latest run failure, when a message racing its running turn caused it. */
export function turnRaceFailure(ctx: FactoryContext, session: Session): InboxItem | undefined {
  const latest = INBOX_STATUSES.flatMap((status) =>
    ctx.inbox.list({ sessionId: session.id, status }),
  )
    .filter((i) => i.kind === "run_failed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest?.body && TURN_RUNNING_TEXT.test(latest.body) ? latest : undefined;
}

/**
 * For a builder that failed or stopped: whether the item waits instead of failing. A builder
 * that failed because of a turn race is told to carry on, and the item waits until the session
 * has moved on since. A stopped one is only waited for once it was told (by the recovery
 * below): the building step never restarts a session someone stopped.
 */
export async function awaitTurnRaceResume(
  ctx: FactoryContext,
  item: FactoryItem,
  s: Session,
): Promise<boolean> {
  const failure = turnRaceFailure(ctx, s);
  if (!failure) return false;
  const asked = item.nudges[NUDGE_PREFIX + failure.id];
  if (asked) return Date.parse(s.updatedAt) <= Date.parse(asked);
  if (s.status !== "failed") return false;
  await resumeBuilder(ctx, item, s, failure);
  return true;
}

/**
 * Items that failed because their builder lost a message race go back to building. The builder
 * is told to carry on, which also brings an archived builder and its worktree back; one that is
 * busy or opened its pull request meanwhile is left to the building step.
 */
export async function recoverTurnRaceFailures(
  ctx: FactoryContext,
  project: Project,
): Promise<void> {
  for (const item of ctx.store.items(project.id, ["failed"])) {
    if (item.reason !== BUILDER_FAILED_REASON || !item.builderSessionId) continue;
    const s = ctx.repo.find(item.builderSessionId)?.session;
    if (!s) continue;
    const failure = turnRaceFailure(ctx, s);
    // Told to carry on once already: a failure after that is real.
    if (!failure || item.nudges[NUDGE_PREFIX + failure.id]) continue;
    const reopened = ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "building",
      reason: null,
      note: "Back to building: its builder was marked failed by a message that raced its turn",
      finishedAt: null,
      sessionsArchivedAt: null,
    }));
    ctx.log?.(`factory: ${item.id}: back to building after a message raced its builder's turn`);
    const pr = s.pr ?? ctx.github.prForSession(project.id, s.id, s.branch);
    if (isBusy(s) || (pr && pr.state !== "closed" && pr.state !== "merged")) continue;
    try {
      await resumeBuilder(ctx, reopened, s, failure);
    } catch (error) {
      // The building step fails the item with the usual reason if the builder stays down.
      ctx.log?.(`factory: ${item.id}: resume message: ${errorMessage(error)}`);
    }
  }
}

async function resumeBuilder(
  ctx: FactoryContext,
  item: FactoryItem,
  s: Session,
  failure: InboxItem,
): Promise<void> {
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: "Its builder was marked failed by a message that raced its turn: told to carry on",
    nudges: { ...i.nudges, [NUDGE_PREFIX + failure.id]: at },
  }));
  await ctx.sessions.message(s.id, BUILDER_RESUME);
}
