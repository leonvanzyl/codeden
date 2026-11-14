import type { ProviderInfo, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type RunnerDeps, type RunnerPort, runnerForSession } from "../runner-port";
import type { SessionLauncher } from "./launcher";
import { isTurnRunningError } from "./outbox-holds";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

/** The message sent to an agent whose turn was cut off by a restart (§4.2). */
export const RESTART_CONTINUE_MESSAGE =
  "You were interrupted by a CodeDen restart; continue where you left off.";

export interface RecoveryDeps extends RunnerDeps {
  repo: SessionRepo;
  sessions: SessionService;
  launcher: SessionLauncher;
  /**
   * After recovery: hide the provider conversations a crash or kill left in a provider's own
   * apps, skipping sessions given to `skip` (`ProviderHistoryService.sweep`).
   */
  sweepVendorHistory?: (
    runner: RunnerPort,
    skip: (sessionId: string) => boolean,
  ) => Promise<{ hidden: string[]; failed: number }>;
  log?: (message: string) => void;
}

const CUT_OFF = ["running", "waiting", "interrupted"] as const;
const isCutOff = (status: string) => (CUT_OFF as readonly string[]).includes(status);

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
    const { repo, sessions } = this.deps;
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
    // Still cut off: not being started, and no message, Retry or queued delivery on its way.
    const stillCutOff = (id: string) => {
      const session = repo.find(id)?.session;
      return (
        !!session &&
        isCutOff(session.status) &&
        !sessions.launching.has(id) &&
        !sessions.isDelivering(id)
      );
    };
    let hosted = await this.hostedSessions(runner);
    if (!hosted) return;
    for (const id of candidates) {
      if (!stillCutOff(id)) continue;
      // Resuming the candidates before this one took a while, and the session may have come
      // back by another path meanwhile: ask the runner again what it hosts now.
      hosted ??= await this.hostedSessions(runner);
      if (!hosted) return;
      if (hosted.has(id) || !stillCutOff(id)) continue;
      // A runner that died without a word left its turns and approvals open: close them
      // first, so a dead approval can't keep the resumed session waiting.
      repo.closeOrphanedTurns(id);
      const session = repo.find(id)?.session;
      if (session && isCutOff(session.status)) {
        await this.resume(session, runner.providers());
        hosted = undefined;
      }
    }

    sessions.releaseOutboxes(onThisRunner);
    for (const id of sessions.sessionsWithQueuedMessages().filter(onThisRunner)) {
      await sessions.flushOutbox(id).catch(() => undefined);
    }

    // Sessions resumed above are mid-turn again (and hosted): the sweep leaves them alone.
    const swept = await this.deps.sweepVendorHistory?.(
      runner,
      (id) => sessions.launching.has(id) || sessions.isDelivering(id),
    );
    if (swept?.hidden.length || swept?.failed) {
      this.deps.log?.(
        `recovery: hid ${swept.hidden.length} conversations a restart left in a provider's app` +
          (swept.failed ? ` (${swept.failed} failed)` : ""),
      );
    }
  }

  /** The sessions the runner hosts right now; undefined (and logged) when it can't say. */
  private async hostedSessions(runner: RunnerPort): Promise<Set<string> | undefined> {
    try {
      const status = await runner.request({ name: "runner.status" }, 10_000);
      return new Set(status.sessions.map((s) => s.sessionId));
    } catch (error) {
      this.deps.log?.(`recovery: runner status failed: ${errorMessage(error)}`);
      return undefined;
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
      // A turn is running: the session came back by another path, so there is nothing to resume.
      if (isTurnRunningError(error)) {
        this.deps.log?.(`recovery: session ${session.id} already has a turn running`);
        return;
      }
      this.deps.launcher.fail(session.id, "restart", error);
    }
  }
}
