import type { FactoryItem, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { SessionRepo } from "../sessions/repo";
import type { FactoryContext } from "./context";
import { isBusy, isFactorySession, LENS_WORK_KEY_PREFIX, SCOUT_WORK_KEY } from "./sessions";
import { FINISHED_STAGES } from "./store";

/**
 * Cleaning up finished work (§10.1, §9): once an item is done, the factory archives its builder
 * and reviewer sessions through the normal archive path, which removes their worktrees. The
 * branch, checkpoints and transcript stay, and a message to a session brings it (and its
 * worktree) back. A session that is busy is never cut off: the item waits for it.
 */

/** The scout and its area reviewers ("lenses") are long-lived: never archived with an item. */
function longLived(s: Session): boolean {
  return s.workKey === SCOUT_WORK_KEY || s.workKey.startsWith(LENS_WORK_KEY_PREFIX);
}

/** Factory sessions an item may archive: not archived yet, and not long-lived. */
function archivable(s: Session | undefined): s is Session {
  return s !== undefined && !s.archivedAt && isFactorySession(s) && !longLived(s);
}

/**
 * The item's sessions that aren't archived yet, in the order to archive them: the factory
 * sessions working in the builder's worktree first (its reviewers, including one restarted
 * after it failed), so the builder's worktree isn't kept for a session still shown in it; then
 * the reviewer; then the builder.
 */
export function sessionsToArchive(ctx: FactoryContext, item: FactoryItem): Session[] {
  const find = (id: string | null) => (id ? ctx.repo.find(id)?.session : undefined);
  const builder = find(item.builderSessionId);
  const inWorktree = builder?.worktreePath
    ? ctx.repo
        .inFolder(builder.worktreePath)
        .filter((s) => s.id !== builder.id && s.projectId === item.projectId)
    : [];
  const seen = new Set<string>();
  return [...inWorktree, find(item.reviewerSessionId), builder].filter((s): s is Session => {
    if (!s || seen.has(s.id)) return false;
    seen.add(s.id);
    return archivable(s);
  });
}

/**
 * A failed item the PM may still allow over the size limit (`factory_allow_large_change`): the
 * size check failed and its pull request is still open. It needs the builder's worktree then.
 */
export function waitingOnLargeChange(ctx: FactoryContext, item: FactoryItem): boolean {
  if (item.stage !== "failed" || !item.pr) return false;
  if (!item.checks.some((c) => c.name === "size" && c.state === "fail")) return false;
  const state = ctx.github.prRef(item.projectId, item.pr.number)?.state ?? item.pr.state;
  return state === "open" || state === "draft";
}

/**
 * The loop's cleanup step. A finished item's sessions are archived once (`sessionsArchivedAt`),
 * so a session someone restores stays; it waits while one of them is busy, or while the PM may
 * still allow it over the size limit. An earlier attempt's sessions (after a retry) are
 * archived once none of them is busy. Escalated items and merges whose main CI is still
 * watched aren't finished. The archives run in the background, so a slow worktree removal
 * never holds up the loop.
 */
export function archiveFinished(ctx: FactoryContext, projectId: string): void {
  for (const item of ctx.store.itemsToClean(projectId)) {
    if (item.earlierSessionIds.length > 0) archiveEarlier(ctx, item);
    if (!FINISHED_STAGES.includes(item.stage) || item.sessionsArchivedAt) continue;
    if (waitingOnLargeChange(ctx, item)) continue;
    const sessions = sessionsToArchive(ctx, item);
    if (sessions.some(isBusy)) continue;
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, sessionsArchivedAt: at }), { touch: false });
    if (sessions.length > 0) ctx.archiveSessions(sessions.map((s) => s.id));
  }
}

/** Archive the sessions of attempts before a retry, once none of them is busy. */
function archiveEarlier(ctx: FactoryContext, item: FactoryItem): void {
  const sessions = item.earlierSessionIds
    .map((id) => ctx.repo.find(id)?.session)
    .filter(archivable);
  if (sessions.some(isBusy)) return;
  const handled = new Set(item.earlierSessionIds);
  ctx.store.updateItem(
    item.id,
    (i) => ({ ...i, earlierSessionIds: i.earlierSessionIds.filter((id) => !handled.has(id)) }),
    { touch: false },
  );
  if (sessions.length > 0) ctx.archiveSessions(sessions.map((s) => s.id));
}

export interface SessionArchiverDeps {
  repo: Pick<SessionRepo, "find">;
  /** The session archive path (`WorktreeCleanup.archive`). */
  archive: (sessionId: string) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Archives finished work's sessions one at a time, in the order queued. Removing a worktree can
 * take a while, so this never runs inside a tick. A session that is gone, archived already or
 * busy again (someone messaged it) by its turn is left alone. Failures are logged; the hourly
 * worktree sweep retries removals that failed.
 */
export class SessionArchiver {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionArchiverDeps) {}

  push(sessionIds: string[]): void {
    this.chain = this.chain
      .then(async () => {
        for (const id of sessionIds) {
          const s = this.deps.repo.find(id)?.session;
          if (!s || s.archivedAt || isBusy(s)) continue;
          await this.deps
            .archive(id)
            .catch((error: unknown) =>
              this.deps.log?.(`factory: archiving session ${id}: ${errorMessage(error)}`),
            );
        }
      })
      .catch((error: unknown) => this.deps.log?.(`factory: archiving: ${errorMessage(error)}`));
  }

  /** Resolves once everything queued so far is done. */
  idle(): Promise<void> {
    return this.chain;
  }
}
