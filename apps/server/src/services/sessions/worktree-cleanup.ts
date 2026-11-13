import type {
  ArchiveSessionResponse,
  RawEventEnvelope,
  Session,
  SessionStatus,
  Settings,
  WorktreeCleanupOutcome,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { badRequest, errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import { type RunnerDeps, runnerErrorCode, runnerForSession } from "../runner-port";
import type { SessionRepo } from "./repo";

export interface WorktreeCleanupDeps extends RunnerDeps {
  repo: SessionRepo;
  projects: ProjectService;
  store: EventStore;
  settings: () => Settings;
  /** Stops a session (provider turn, queued messages, open approvals) before it is archived. */
  stopSession: (id: string) => Promise<unknown>;
  /** Where a removal that keeps failing is reported (`cleanup_failed`). */
  inbox?: Pick<InboxService, "find" | "put" | "close">;
  /**
   * Waits before trying a removal that failed on a file in use again, one per retry (default
   * `RETRY_DELAYS_MS`). Only once they are used up is the failure reported.
   */
  retryDelaysMs?: readonly number[];
  /** Waits between attempts (tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How often the inactivity sweep runs (default hourly). */
  intervalMs?: number;
  /** Delay before the first sweep after start (default one minute). */
  initialDelayMs?: number;
  log?: (message: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
/**
 * Backoff between attempts at a removal that failed because something held a file: Windows
 * releases files a moment after the process holding them ends, and each attempt ends what
 * still runs in the worktree again.
 */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];
/** Runner errors that a later attempt can get past (a file in use, a delete that failed). */
const TRANSIENT = new Set(["worktree_in_use", "remove_failed"]);
/** Sessions that may be using their worktree right now; never cleaned up. */
const IN_USE: ReadonlySet<SessionStatus> = new Set([
  "created",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const outcome = (
  status: WorktreeCleanupOutcome["status"],
  message: string | null = null,
): WorktreeCleanupOutcome => ({ status, message });

/**
 * Whether the sweep should remove a session's worktree now: an agent session that owns a
 * worktree it is not using, and is either archived or has been inactive for `afterDays`
 * without an open pull request. Archived sessions are retried even with cleanup off.
 */
export function cleanupDue(session: Session, now: Date, settings: Settings["worktrees"]): boolean {
  if (session.role !== "agent" || !session.projectId) return false;
  if (!session.worktreePath || session.worktreeRemovedAt) return false;
  if (IN_USE.has(session.status)) return false;
  if (session.archivedAt) return true;
  if (!settings.cleanup) return false;
  if (session.pr && (session.pr.state === "open" || session.pr.state === "draft")) return false;
  return now.getTime() - Date.parse(session.updatedAt) >= settings.afterDays * DAY_MS;
}

/**
 * Worktree cleanup (§9). Archiving a session removes its worktree right away; the hourly sweep
 * retries archived sessions whose removal failed and removes worktrees of sessions inactive for
 * the configured number of days; archiving a project cleans up its sessions. Uncommitted changes
 * always keep a worktree unless the user forces removal. Everything goes through the runner's
 * workspace commands, so a remote runner cleans up its own storage. The branch and checkpoints
 * stay, and the next message recreates the worktree.
 */
export class WorktreeCleanup {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private sweeping = false;
  /** Sessions the sweep could not clean (dirty, locked), keyed to the `updatedAt` it saw. */
  private readonly kept = new Map<string, string>();
  /** Archived sessions whose user chose to discard uncommitted changes, until removed. */
  private readonly forced = new Set<string>();

  constructor(private readonly deps: WorktreeCleanupDeps) {}

  /** Whether another live session works in the same folder (never removed under it). */
  private sharedWithLiveSession(session: Session): boolean {
    const norm = (p: string) =>
      p
        .replace(/[\\/]+$/, "")
        .replace(/\\/g, "/")
        .toLowerCase();
    const path = norm(session.worktreePath ?? "");
    return this.deps.repo
      .list({ role: "agent" })
      .some(
        (other) =>
          other.id !== session.id &&
          !other.archivedAt &&
          !other.worktreeRemovedAt &&
          [other.worktreePath, other.cwd].some((p) => p && norm(p) === path),
      );
  }

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => {
      setImmediate(() => this.onEvents(events));
    });
    const interval = this.deps.intervalMs ?? 60 * 60_000;
    const first = setTimeout(() => {
      void this.sweep();
      this.timer = setInterval(() => void this.sweep(), interval);
      this.timer.unref?.();
    }, this.deps.initialDelayMs ?? 60_000);
    first.unref?.();
    this.timer = first;
  }

  stop(): void {
    this.unsubscribe?.();
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  /**
   * Stop the session if needed, hide it from the sidebar and remove its worktree. A worktree
   * with uncommitted changes is kept unless `force`. Calling it again on an archived session
   * retries a failed removal; a forced archive that failed is finished by the sweep.
   */
  async archive(id: string, opts: { force?: boolean } = {}): Promise<ArchiveSessionResponse> {
    const current = this.deps.repo.get(id);
    if (current.role !== "agent") {
      throw badRequest("Only agent sessions can be archived", "not_archivable");
    }
    if (IN_USE.has(current.status) || current.status === "idle") {
      await this.deps.stopSession(id);
    }
    this.deps.repo.update(id, (s) =>
      s.archivedAt ? s : { ...s, archivedAt: this.now().toISOString() },
    );
    const force = opts.force === true;
    if (force) this.forced.add(id);
    const worktree = await this.removeWorktree(id, { force });
    return { session: this.deps.repo.get(id), worktree };
  }

  /** Show an archived session again. Its worktree comes back with the next message. */
  unarchive(id: string): Session {
    this.forced.delete(id);
    return this.deps.repo.update(id, (s) => (s.archivedAt ? { ...s, archivedAt: null } : s));
  }

  /**
   * Remove a session's worktree through the runner. Refuses while the session (or another live
   * session in the same folder) is in use, and keeps a worktree with uncommitted changes unless
   * `force`. A removal that fails on a file in use is tried again after a short backoff
   * (`retryDelaysMs`), and only a failure that outlasts it is reported (`cleanup_failed`). The
   * runner also cleans up a folder an earlier removal left half-deleted.
   */
  async removeWorktree(id: string, opts: { force: boolean }): Promise<WorktreeCleanupOutcome> {
    const delays = this.deps.retryDelaysMs ?? RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const result = await this.tryRemove(id, opts);
      if (!result.failure) return result.outcome;
      const { session, error } = result.failure;
      const delay = delays[attempt];
      if (delay !== undefined && TRANSIENT.has(runnerErrorCode(error) ?? "")) {
        await this.sleep(delay);
        continue;
      }
      const message = errorMessage(error);
      this.deps.log?.(`worktree cleanup: could not remove ${session.worktreePath}: ${message}`);
      this.reportFailure(session, message);
      return result.outcome;
    }
  }

  /** One attempt at `removeWorktree`; a runner error comes back as `failure`, unreported. */
  private async tryRemove(
    id: string,
    opts: { force: boolean },
  ): Promise<{
    outcome: WorktreeCleanupOutcome;
    failure?: { session: Session; error: unknown };
  }> {
    const done = (o: WorktreeCleanupOutcome) => ({ outcome: o });
    const session = this.deps.repo.get(id);
    if (!session.worktreePath || session.worktreeRemovedAt || !session.projectId) {
      return done(outcome("none"));
    }
    if (IN_USE.has(session.status)) {
      return done(outcome("failed", "The session is still working; stop it first"));
    }
    if (this.sharedWithLiveSession(session)) {
      return done(outcome("failed", "Another session is working in this worktree, so it was kept"));
    }
    let repoPath: string;
    try {
      repoPath = this.deps.projects.get(session.projectId).path;
    } catch {
      return done(outcome("none"));
    }
    // The worktree lives with the runner that made it: the session's own.
    const runner = runnerForSession(this.deps, id);
    if (!runner.isConnected()) {
      const name = runner.describe?.() ?? "The runner";
      return done(outcome("failed", `${name} is not connected; cleanup will retry later`));
    }
    // Provider processes run in the worktree (a reviewer's too, in its builder's): detach every
    // session there before the folder goes away, also one whose status already says it ended.
    for (const s of this.deps.repo.inFolder(session.worktreePath)) {
      await runnerForSession(this.deps, s.id)
        .request({ name: "session.stop", sessionId: s.id }, 15_000)
        .catch(() => undefined);
    }
    let discarded = false;
    try {
      const result = await runner.request(
        { name: "workspace.remove", repoPath, path: session.worktreePath, force: opts.force },
        REMOVE_TIMEOUT_MS,
      );
      discarded = result.discardedChanges === true;
    } catch (error) {
      const message = errorMessage(error);
      if (runnerErrorCode(error) === "worktree_dirty" || /modified or untracked/.test(message)) {
        return done(
          outcome("kept_changes", "The worktree has uncommitted changes, so it was kept"),
        );
      }
      return { outcome: outcome("failed", message), failure: { session, error } };
    }
    this.deps.repo.update(id, (s) => ({ ...s, worktreeRemovedAt: this.now().toISOString() }));
    this.kept.delete(id);
    this.forced.delete(id);
    this.clearFailure(id);
    this.deps.log?.(`worktree cleanup: removed ${session.worktreePath}`);
    return done(outcome("removed", discarded ? "Its uncommitted changes were discarded" : null));
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  /**
   * Remove every worktree that is due (see `cleanupDue`), so an archive whose removal failed (a
   * file in use, or a folder an older version left half-deleted) finishes here. Uncommitted
   * changes keep a worktree unless the user forced its archive (remembered until restart). A
   * worktree kept for uncommitted changes is skipped until its session changes; failures are
   * retried every sweep. Returns the cleaned session ids.
   */
  async sweep(): Promise<string[]> {
    if (this.sweeping || !this.deps.runner.isConnected()) return [];
    this.sweeping = true;
    const removed: string[] = [];
    try {
      const now = this.now();
      const settings = this.deps.settings().worktrees;
      for (const session of this.deps.repo.list({ role: "agent" })) {
        if (!cleanupDue(session, now, settings)) continue;
        if (this.kept.get(session.id) === session.updatedAt) continue;
        const force = Boolean(session.archivedAt) && this.forced.has(session.id);
        const result = await this.removeWorktree(session.id, { force });
        if (result.status === "removed") removed.push(session.id);
        else if (result.status === "kept_changes") {
          this.kept.set(session.id, this.deps.repo.get(session.id).updatedAt);
        }
      }
    } catch (error) {
      this.deps.log?.(`worktree cleanup failed: ${errorMessage(error)}`);
    } finally {
      this.sweeping = false;
    }
    return removed;
  }

  /** Clean up the worktrees of an archived project's sessions that are not in use. */
  async cleanProject(projectId: string): Promise<string[]> {
    const removed: string[] = [];
    for (const session of this.deps.repo.list({ projectId, role: "agent" })) {
      if (!session.worktreePath || session.worktreeRemovedAt || IN_USE.has(session.status)) {
        continue;
      }
      const result = await this.removeWorktree(session.id, { force: false });
      if (result.status === "removed") removed.push(session.id);
    }
    return removed;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "project.archived") continue;
      const projectId = (e.payload as { projectId?: unknown }).projectId;
      if (typeof projectId === "string") {
        void this.cleanProject(projectId).catch((error: unknown) =>
          this.deps.log?.(`worktree cleanup for project ${projectId}: ${errorMessage(error)}`),
        );
      }
    }
  }

  /**
   * Put a failed removal in the inbox (`cleanup_failed`), so it can't go unnoticed while the
   * sweep keeps retrying. One item per session: updated when the reason changes, reopened
   * after an earlier one was resolved, and left alone once the user dismissed it.
   */
  private reportFailure(session: Session, message: string): void {
    const inbox = this.deps.inbox;
    if (!inbox) return;
    const id = cleanupInboxId(session.id);
    const existing = inbox.find(id);
    const body = `${message}\n\nCodeDen tries again every hour; archive the session again to retry now.`;
    if (
      existing?.status === "dismissed" ||
      (existing?.status === "open" && existing.body === body)
    ) {
      return;
    }
    const now = this.now().toISOString();
    inbox.put({
      id,
      kind: "cleanup_failed",
      status: "open",
      priority: "normal",
      notify: "failure",
      title: `Couldn't remove the worktree: ${session.title ?? session.purpose}`,
      body,
      projectId: session.projectId,
      sessionId: session.id,
      threadId: session.rootThreadId,
      itemId: null,
      requestId: null,
      issue: session.issue,
      pr: session.pr,
      automationRunId: session.automationRunId,
      createdAt: existing?.status === "open" ? existing.createdAt : now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    });
  }

  /** The worktree is gone: resolve its open `cleanup_failed` item. */
  private clearFailure(sessionId: string): void {
    const item = this.deps.inbox?.find(cleanupInboxId(sessionId));
    if (item?.status === "open") this.deps.inbox?.close(item, "resolved", { removed: true });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** The inbox item reporting that a session's worktree could not be removed. */
export function cleanupInboxId(sessionId: string): string {
  return `inbox:${sessionId}:worktree-cleanup`;
}
