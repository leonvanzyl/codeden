import type { ProviderInfo, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type RunnerDeps, runnerForSession } from "../runner-port";
import type { SessionLauncher } from "./launcher";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

/** The message sent to an agent whose turn was cut off by a restart (§4.2). */
export const RESTART_CONTINUE_MESSAGE =
  "You were interrupted by a CodeDen restart; continue where you left off.";

export interface RecoveryDeps extends RunnerDeps {
  repo: SessionRepo;
  sessions: SessionService;
  launcher: SessionLauncher;
  log?: (message: string) => void;
}

const CUT_OFF = ["running", "waiting", "interrupted"] as const;

/**
 * After a runner (re)connects: resume its sessions whose turn was cut off by a runner drain,
 * restart or crash, with an automatic "continue" message, and deliver messages that were
 * queued before a server restart. Idle sessions are resumed lazily on their next message.
 * Only sessions that runner hosts (`sessions.runnerId`, else the home runner) are touched.
 */
export class SessionRecovery {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Called when a current runner is connected and configured; `runnerId` is its journal id
   * (omitted: the home runner). Never throws.
   */
  onRunnerReady(runnerId?: string): Promise<void> {
    const key = runnerId ?? "";
    let running = this.running.get(key);
    if (!running) {
      running = this.recover(runnerId).finally(() => this.running.delete(key));
      this.running.set(key, running);
    }
    return running;
  }

  private async recover(runnerId: string | undefined): Promise<void> {
    const { repo, sessions, log } = this.deps;
    const runner =
      runnerId && this.deps.runners ? this.deps.runners.forRunnerId(runnerId) : this.deps.runner;
    const onThisRunner = (id: string) => runnerForSession(this.deps, id) === runner;
    // Only sessions that were cut off before this runner was ready. A session started on it
    // meanwhile can turn `running` while `runner.status` is in flight (its first events can
    // arrive in the same read as the reply) and must not be mistaken for a cut-off one.
    const candidates = repo
      .list({ status: [...CUT_OFF] })
      .filter((s) => !sessions.launching.has(s.id) && onThisRunner(s.id))
      .map((s) => s.id);
    let hosted: Set<string>;
    try {
      const status = await runner.request({ name: "runner.status" }, 10_000);
      hosted = new Set(status.sessions.map((s) => s.sessionId));
    } catch (error) {
      log?.(`recovery: runner status failed: ${errorMessage(error)}`);
      return;
    }
    for (const id of candidates) {
      const found = repo.find(id)?.session;
      if (!found || hosted.has(id) || sessions.launching.has(id)) continue;
      if (!(CUT_OFF as readonly string[]).includes(found.status)) continue;
      // A runner that died without a word left its turns and approvals open: close them
      // first, so a dead approval can't keep the resumed session waiting.
      repo.closeOrphanedTurns(id);
      const session = repo.find(id)?.session;
      if (session && (CUT_OFF as readonly string[]).includes(session.status)) {
        await this.resume(session, runner.providers());
      }
    }

    sessions.releaseOutboxes(onThisRunner);
    for (const id of sessions.sessionsWithQueuedMessages().filter(onThisRunner)) {
      await sessions.flushOutbox(id).catch(() => undefined);
    }
  }

  private async resume(session: Session, providers: ProviderInfo[]): Promise<void> {
    const provider = providers.find((p) => p.id === session.provider);
    if (!session.resumeToken || !provider?.capabilities.resume) {
      this.deps.launcher.fail(
        session.id,
        "restart",
        new Error("The session was cut off by a restart and cannot be resumed"),
      );
      return;
    }
    try {
      this.deps.log?.(`recovery: resuming session ${session.id}`);
      await this.deps.sessions.continueAfterRestart(session.id, RESTART_CONTINUE_MESSAGE);
    } catch (error) {
      this.deps.launcher.fail(session.id, "restart", error);
    }
  }
}
