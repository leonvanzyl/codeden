import {
  type DiscoveryArea,
  type FactoryItem,
  type Session,
  StartSessionRequest,
  type StartSessionRequestInit,
  type StartSessionResponse,
  type UserInput,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import type { ProviderAvailability, ProviderRunnable, Unavailable } from "./availability";
import { builderPrompt, revertPrompt, reviewerPrompt } from "./prompts";
import { FACTORY_STARTER, isFactorySession } from "./starter";

export { FACTORY_STARTER, isFactorySession };

/**
 * A brief or follow-up from the factory loop, recorded as the factory's so the transcript shows
 * it as a Markdown card headed "Factory" instead of the user's plain text.
 */
function brief(text: string): UserInput {
  return { text, attachments: [], from: "factory" };
}

/** Statuses that hold a session slot (`maxConcurrentSessions`). */
const SLOT_STATUSES = new Set(["created", "queued", "starting", "running", "waiting"]);
/** Statuses of sessions the kill switch stops. */
const LIVE_STATUSES = new Set([...SLOT_STATUSES, "idle", "interrupted"]);

/** Work key of the dark factory's scout (one long-lived session per project). */
export const SCOUT_WORK_KEY = "factory:scout";
/** Work key prefix of the scout's area reviewers ("lenses": one long-lived session per area). */
export const LENS_WORK_KEY_PREFIX = "factory:lens:";

/** Whether a session is busy with a turn (or about to start one). */
export function isBusy(s: Session): boolean {
  return SLOT_STATUSES.has(s.status);
}

export interface FactorySessionsDeps {
  sessions: SessionService;
  repo: SessionRepo;
  runner: RunnerPort;
  availability: ProviderAvailability;
  log?: (message: string) => void;
}

/** Starts and stops the factory's agent sessions through the normal session service (§8.2). */
export class FactorySessions {
  constructor(private readonly deps: FactorySessionsDeps) {}

  /** Factory sessions of a project, newest first. */
  list(projectId: string): Session[] {
    return this.deps.repo.list({ projectId, role: "agent" }).filter(isFactorySession);
  }

  /** Factory sessions holding a slot right now, leaving out `except` (a session's own slot). */
  activeCount(projectId: string, except?: string): number {
    return this.list(projectId).filter((s) => s.id !== except && SLOT_STATUSES.has(s.status))
      .length;
  }

  /** Providers the runner offers (the Fake provider only when nothing else is there). */
  registered(): string[] {
    const ids = this.deps.runner.providers().map((p) => p.id);
    const real = ids.filter((id) => id !== "fake");
    return real.length > 0 ? real : ids;
  }

  /**
   * Providers new factory sessions may use: offered by the runner, installed, signed in and not
   * at a usage limit (see `ProviderAvailability`).
   */
  providers(): string[] {
    return this.registered().filter((id) => !this.deps.availability.unavailable(id));
  }

  /** Registered providers that can't take new work, and why. */
  unavailable(): Array<{ provider: string } & Unavailable> {
    return this.registered().flatMap((provider) => {
      const u = this.deps.availability.unavailable(provider);
      return u ? [{ provider, ...u }] : [];
    });
  }

  /**
   * Whether new work can start on `provider` now and, if not, why and the fix (see
   * `ProviderAvailability.runnable`). A provider the runner doesn't offer can't run either.
   * Starts a background detection when the last one is old; never waits for it.
   */
  runnable(provider: string, opts: { ignoreFailures?: boolean } = {}): ProviderRunnable {
    this.deps.availability.refresh();
    const name = this.displayName(provider);
    if (!this.deps.runner.providers().some((p) => p.id === provider)) {
      const reason = "not offered by the runner";
      return {
        runnable: false,
        reason,
        until: null,
        detail: null,
        fix: null,
        message: `${name} is ${reason}`,
      };
    }
    return this.deps.availability.runnable(provider, name, opts);
  }

  /**
   * Whether a person's action (Retry) can run on `provider` now. The factory's back-off after its
   * own sessions failed there doesn't apply, and before refusing, providers are detected again
   * and waited for, so a CLI just signed in or updated isn't refused from an old detection.
   */
  async runnableNow(provider: string): Promise<ProviderRunnable> {
    const cached = this.runnable(provider, { ignoreFailures: true });
    if (cached.runnable) return cached;
    await this.deps.availability.detectNow();
    return this.runnable(provider, { ignoreFailures: true });
  }

  /** The provider's name for notes ("Codex"), from the runner's provider list. */
  displayName(id: string): string {
    return this.deps.runner.providers().find((p) => p.id === id)?.displayName ?? id;
  }

  /** Detect providers again in the background when the last detection is old (never waits). */
  refreshAvailability(): void {
    this.deps.availability.refresh();
  }

  /** A factory session failed because of its provider: new work skips it for a while. */
  providerFailed(provider: string, reason: string, until: string | null): void {
    this.deps.availability.markFailed(provider, reason, until);
  }

  /** Stop one session; failures are only logged. */
  async stop(sessionId: string): Promise<void> {
    try {
      await this.deps.sessions.stop(sessionId);
    } catch (error) {
      this.deps.log?.(`factory: stop ${sessionId}: ${errorMessage(error)}`);
    }
  }

  /**
   * A long-lived session the scout uses round after round, if it can take another message:
   * it exists, isn't archived and didn't fail.
   */
  reusable(sessionId: string | null | undefined): Session | undefined {
    if (!sessionId) return undefined;
    const s = this.deps.repo.find(sessionId)?.session;
    if (!s || s.status === "failed" || s.archivedAt) return undefined;
    return s;
  }

  /** Start the dark factory's scout with its first round's brief. */
  startScout(projectId: string, text: string): Promise<StartSessionResponse> {
    return this.start({
      projectId,
      purpose: "Factory scout: review the app against the vision and file the work",
      workKey: SCOUT_WORK_KEY,
      scope: { area: "factory-scout" },
      title: "Factory scout",
      input: brief(text),
    });
  }

  /** Start one of the scout's area reviewers (long-lived, one per review area). */
  startLens(projectId: string, area: DiscoveryArea, text: string): Promise<StartSessionResponse> {
    const name = area.replace("_", " ");
    return this.start({
      projectId,
      purpose: `Factory area reviewer: review ${name}`,
      workKey: `${LENS_WORK_KEY_PREFIX}${area}`,
      scope: { area: `factory-lens-${area}` },
      title: `Factory area reviewer: ${name}`,
      input: brief(text),
    });
  }

  startBuilder(
    item: FactoryItem,
    vision: string,
    provider: string,
    model: string | null = null,
  ): Promise<StartSessionResponse> {
    const step = item.type ? ` (${item.type})` : "";
    return this.start({
      projectId: item.projectId,
      provider,
      ...(model ? { model } : {}),
      purpose: `Factory${step}: ${item.title}`.slice(0, 300),
      workKey: item.workKey,
      title: item.title.slice(0, 200),
      issue: item.issue ?? undefined,
      input: brief(builderPrompt(item, vision)),
    });
  }

  /**
   * Start the reviewer: in a new worktree on the PR's head, fetched from origin by CodeDen
   * before the session starts, when `pr` is given (a revert PR opened through the API, or an
   * earlier reviewer's environment in the builder's worktree couldn't verify the change);
   * otherwise offline in the builder's worktree when there is one.
   */
  startReviewer(
    item: FactoryItem,
    vision: string,
    reviewer: { provider: string; model: string | null },
    note: string | null,
    /** The PR's head to review in a fresh worktree; null to use the builder's worktree. */
    pr: { headBranch: string; baseBranch: string } | null,
    autoMerge: boolean,
    /** A brief of its own instead of the whole review (a conflict resolution's re-check). */
    text?: string,
  ): Promise<StartSessionResponse> {
    const builder = item.builderSessionId
      ? this.deps.repo.find(item.builderSessionId)?.session
      : undefined;
    // A worktree cleanup removed is no place to review: the PR's head is fetched instead.
    const worktree = builder && !builder.worktreeRemovedAt ? builder.worktreePath : null;
    let workspace: StartSessionRequest["workspace"] = { mode: "worktree" };
    let localBase: string | null = null;
    if (pr) {
      workspace = {
        mode: "worktree",
        branch: `codeden/review-${item.pr?.number ?? item.id.slice(0, 8)}-${item.id.slice(0, 4)}`,
        baseRef: `origin/${pr.headBranch}`,
        fetch: true,
      };
      localBase = `origin/${pr.baseBranch}`;
    } else if (worktree) {
      workspace = { mode: "existing", path: worktree };
      localBase = builder?.baseBranch ?? "main";
    }
    return this.start({
      projectId: item.projectId,
      provider: reviewer.provider,
      ...(reviewer.model ? { model: reviewer.model } : {}),
      purpose: `Factory review: ${item.title}`.slice(0, 300),
      workKey: `factory:review:${item.pr?.number ?? item.id}`,
      title: `Review: ${item.title}`.slice(0, 200),
      issue: item.issue ?? undefined,
      workspace,
      input: brief(text ?? reviewerPrompt(item, vision, note, localBase, autoMerge)),
    });
  }

  /**
   * Start an integrator: a fresh session on a factory PR's head branch (fetched by CodeDen) that
   * resolves its merge conflicts because the session that wrote it is gone. Its worktree's
   * branch is the PR's, so `create_pull_request` updates the same pull request.
   */
  startIntegrator(
    item: FactoryItem,
    pr: { number: number; headBranch: string },
    text: string,
  ): Promise<StartSessionResponse> {
    return this.start({
      projectId: item.projectId,
      purpose: `Factory integration: resolve the conflicts of #${pr.number}`,
      workKey: `factory:integrate:${pr.number}`,
      title: `Integrate #${pr.number}: ${item.title}`.slice(0, 200),
      issue: item.issue ?? undefined,
      workspace: {
        mode: "worktree",
        branch: pr.headBranch,
        baseRef: `origin/${pr.headBranch}`,
        fetch: true,
      },
      input: brief(text),
    });
  }

  startRevert(
    projectId: string,
    merge: { sha: string; prNumber: number; title: string },
  ): Promise<StartSessionResponse> {
    return this.start({
      projectId,
      purpose: `Factory: revert #${merge.prNumber} after a CI regression`,
      workKey: `factory:revert:${merge.sha.slice(0, 7)}`,
      title: `Revert #${merge.prNumber}`,
      input: brief(revertPrompt(merge)),
    });
  }

  /** Send a follow-up to a session (queued behind a running turn). */
  async message(sessionId: string, text: string): Promise<void> {
    await this.deps.sessions.send(sessionId, { input: brief(text), whenBusy: "queue" }, "factory");
  }

  /**
   * Start a turn with this message now, or not at all: it is never queued, so a turn the
   * factory admitted under its agent limit can't start later, past that limit. Throws when a
   * turn is running or the runner can't take it (away, timed out). For a session that is not
   * busy (the queue is only used for one that hasn't started yet).
   */
  async startTurn(sessionId: string, text: string): Promise<void> {
    const res = await this.deps.sessions.send(
      sessionId,
      { input: brief(text), whenBusy: "reject" },
      "factory",
    );
    if (res.status !== "sent") throw new Error(`The message was ${res.status}, not sent`);
  }

  /** Stop every live factory session of a project (kill switch). Returns the stopped ids. */
  async stopAll(projectId: string): Promise<string[]> {
    const stopped: string[] = [];
    for (const s of this.list(projectId)) {
      if (!LIVE_STATUSES.has(s.status)) continue;
      try {
        await this.deps.sessions.stop(s.id);
        stopped.push(s.id);
      } catch (error) {
        this.deps.log?.(`factory: stop ${s.id}: ${errorMessage(error)}`);
      }
    }
    return stopped;
  }

  private start(req: StartSessionRequestInit): Promise<StartSessionResponse> {
    return this.deps.sessions.start(
      StartSessionRequest.parse({ role: "agent", startedBy: FACTORY_STARTER, ...req }),
    );
  }
}
