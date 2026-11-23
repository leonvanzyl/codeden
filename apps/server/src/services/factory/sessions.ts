import {
  ACTIVE_SESSION_STATUSES,
  type DiscoveryArea,
  type FactoryItem,
  isActiveSession,
  type ModelInfo,
  type Session,
  StartSessionRequest,
  type StartSessionRequestInit,
  type StartSessionResponse,
  type UserInput,
} from "@codeden/contracts";
import { errorMessage, ServiceError } from "../errors";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import type { AgentChoice } from "./agent-choice";
import type {
  ProviderAvailability,
  ProviderCause,
  ProviderRunnable,
  Unavailable,
} from "./availability";
import { type BriefLessons, builderPrompt, NO_LESSONS, reviewerPrompt } from "./prompts";
import { revertPrompt } from "./prompts-revert";
import { FACTORY_STARTER, isFactorySession } from "./starter";

export { FACTORY_STARTER, isFactorySession };

/** A provider the runner offers, as a choice for new work (`FactorySessions.choices`). */
export interface ProviderChoice extends ProviderRunnable {
  id: string;
  /** Its name for people ("Gemini CLI"). */
  name: string;
  /** False while providers haven't been detected yet, so `runnable` isn't known to be true. */
  checked: boolean;
}

/**
 * A brief or follow-up from the factory loop, recorded as the factory's so the transcript shows
 * it as a Markdown card headed "Factory" instead of the user's plain text.
 */
function brief(text: string): UserInput {
  return { text, attachments: [], from: "factory" };
}

/** A start request's provider and model: a model only when one is chosen. */
function on(agent: AgentChoice): Pick<StartSessionRequestInit, "provider" | "model"> {
  return { provider: agent.provider, ...(agent.model ? { model: agent.model } : {}) };
}

/** Statuses of sessions the kill switch stops: working ones, and those between turns. */
const LIVE_STATUSES = new Set([...ACTIVE_SESSION_STATUSES, "idle", "interrupted"]);

/** Work key of the dark factory's scout (one long-lived session per project). */
export const SCOUT_WORK_KEY = "factory:scout";
/** Work key prefix of the scout's area reviewers ("lenses": one long-lived session per area). */
export const LENS_WORK_KEY_PREFIX = "factory:lens:";
/** Work key prefix of the independent reviewers of factory pull requests. */
export const REVIEW_WORK_KEY_PREFIX = "factory:review:";

/** Whether a session is busy with a turn (or about to start one). */
export function isBusy(s: Session): boolean {
  return isActiveSession(s);
}

/**
 * Whether the session never ran a turn: its start failed before the provider saw its first input
 * (the runner left `session.start` unanswered, the workspace was never prepared, or the provider
 * refused to open it). A builder's brief is only that input, so such a builder has nothing to
 * carry on and nothing that ties its work to its provider (`recover.ts`, `provider-wait.ts`).
 */
export function neverRanTurn(repo: Pick<SessionRepo, "turnCount">, s: Session): boolean {
  return repo.turnCount(s.id) === 0;
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

  /**
   * Factory sessions holding a slot (`maxConcurrentSessions`) right now: working or about to
   * (`isActiveSession`), leaving out `except` (a session's own slot).
   */
  activeCount(projectId: string, except?: string): number {
    return this.list(projectId).filter((s) => s.id !== except && isActiveSession(s)).length;
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
   * Every provider the runner offers, with whether new work can start on it now and why not
   * (`runnable`). `checked` is false while no detection has answered yet: then a provider that
   * looks runnable only hasn't been looked at.
   */
  async choices(): Promise<ProviderChoice[]> {
    const checked = await this.deps.availability.ensureDetected();
    return this.deps.runner.providers().map((p) => ({
      id: p.id,
      name: p.displayName,
      checked,
      ...this.deps.availability.runnable(p.id, p.displayName),
    }));
  }

  /**
   * Whether a person's action (Retry) can run on `provider` now. The factory's back-off after its
   * own sessions failed there doesn't apply, and before refusing, providers are detected again
   * and waited for, so a CLI just signed in or updated isn't refused from an old detection. A
   * person retrying on the provider also ends the factory's sign-in back-off there: they may
   * have just signed in (the next failure backs it off again).
   */
  async runnableNow(provider: string): Promise<ProviderRunnable> {
    this.deps.availability.recheck(provider);
    const cached = this.runnable(provider, { ignoreFailures: true });
    if (cached.runnable) return cached;
    await this.deps.availability.detectNow();
    return this.runnable(provider, { ignoreFailures: true });
  }

  /** The models a provider lists (aliases with the full ids they run), from the runner. */
  models(provider: string): ModelInfo[] {
    return this.deps.runner.providers().find((p) => p.id === provider)?.models ?? [];
  }

  /** The provider's name for notes ("Codex"), from the runner's provider list. */
  displayName(id: string): string {
    return this.deps.runner.providers().find((p) => p.id === id)?.displayName ?? id;
  }

  /** Detect providers again in the background when the last detection is old (never waits). */
  refreshAvailability(): void {
    this.deps.availability.refresh();
  }

  /**
   * A factory session failed because of its provider: new work skips it for a while, or until
   * its login changes after a sign-in failure. With `failedAt`, a failure from before the factory
   * last learned something about the provider (it backed it off, a person asked to check it
   * again, a new login) changes nothing: it was acted on already, or the provider is fixed since.
   */
  providerFailed(provider: string, cause: ProviderCause, failedAt?: string): void {
    if (failedAt && this.deps.availability.changedSince(provider, failedAt)) return;
    this.deps.availability.markFailed(provider, cause.reason, cause.until, cause.signin);
  }

  /**
   * A person asks the factory to check now: providers backed off after a sign-in failure are
   * tried again (they may have just signed in), and providers are detected again in the
   * background.
   */
  recheckProviders(): void {
    this.deps.availability.recheck();
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

  /**
   * Start the dark factory's scout with its first round's brief, on `agent`'s provider and model
   * (`scoutProvider`/`scoutModel`, `agent-choice.ts`; `auto`: the project's or role's default).
   */
  startScout(projectId: string, text: string, agent: AgentChoice): Promise<StartSessionResponse> {
    return this.start({
      projectId,
      ...on(agent),
      purpose: "Factory scout: review the app against the vision and file the work",
      workKey: SCOUT_WORK_KEY,
      scope: { area: "factory-scout" },
      title: "Factory scout",
      input: brief(text),
    });
  }

  /** Start one of the scout's area reviewers (long-lived, one per review area), as the scout. */
  startLens(
    projectId: string,
    area: DiscoveryArea,
    text: string,
    agent: AgentChoice,
  ): Promise<StartSessionResponse> {
    const name = area.replace("_", " ");
    return this.start({
      projectId,
      ...on(agent),
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
    /** The project's lessons for its brief (`lessons.ts`). */
    lessons: BriefLessons = NO_LESSONS,
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
      input: brief(builderPrompt(item, vision, lessons)),
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
    /** The project's lessons for the whole review's brief (`lessons.ts`). */
    lessons: BriefLessons = NO_LESSONS,
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
      workKey: `${REVIEW_WORK_KEY_PREFIX}${item.pr?.number ?? item.id}`,
      title: `Review: ${item.title}`.slice(0, 200),
      issue: item.issue ?? undefined,
      workspace,
      input: brief(text ?? reviewerPrompt(item, vision, note, localBase, autoMerge, lessons)),
    });
  }

  /**
   * Start an integrator: a fresh session on a factory PR's head branch (fetched by CodeDen) that
   * resolves its merge conflicts because the session that wrote it is gone. Its worktree's
   * branch is the PR's, so `create_pull_request` updates the same pull request. It runs on
   * `agent`'s provider and model (chosen as the item's builder is, with fallback, `rebase.ts`).
   */
  startIntegrator(
    item: FactoryItem,
    pr: { number: number; headBranch: string },
    text: string,
    agent: AgentChoice,
  ): Promise<StartSessionResponse> {
    return this.start({
      projectId: item.projectId,
      ...on(agent),
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

  /**
   * Start the agent writing an automatic revert, on `agent`'s provider and model (chosen as a
   * bug's builder is, with fallback, `revert-start.ts`).
   */
  startRevert(
    projectId: string,
    merge: { sha: string; prNumber: number; title: string },
    agent: AgentChoice,
  ): Promise<StartSessionResponse> {
    return this.start({
      projectId,
      ...on(agent),
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
   * Compact a session's conversation now ("Compact now", `SessionService.compact`), so the next
   * message queues behind the compaction. False when it can't now (a provider that can't compact
   * on demand, a turn running, the runner away); never throws.
   */
  async compact(sessionId: string): Promise<boolean> {
    try {
      await this.deps.sessions.compact(sessionId);
      return true;
    } catch (error) {
      // A provider that can't compact on demand is no news: its own compaction still runs.
      if (!(error instanceof ServiceError && error.code === "unsupported")) {
        this.deps.log?.(`factory: compact ${sessionId}: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  /**
   * Withdraw the factory's messages still waiting in a session's queue (a rebase or revise
   * request for a PR that merged or closed meanwhile). Returns how many were withdrawn; never
   * throws.
   */
  withdrawQueued(sessionId: string): number {
    try {
      return this.deps.sessions.dropQueued(sessionId, "factory");
    } catch (error) {
      this.deps.log?.(`factory: withdraw queued ${sessionId}: ${errorMessage(error)}`);
      return 0;
    }
  }

  /**
   * Whether a message to the session waits in its queue or is on its way to the runner: the
   * session hasn't started that turn yet, though it may look idle (a compaction just ended).
   */
  hasPendingMessage(sessionId: string): boolean {
    return this.deps.sessions.hasOutbox(sessionId) || this.deps.sessions.isDelivering(sessionId);
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
  stopAll(projectId: string): Promise<string[]> {
    return this.stopWhere(projectId, () => true);
  }

  /**
   * Stop the scout and its area reviewers (a drain begins: they only find new work). Returns
   * the stopped ids.
   */
  stopScouts(projectId: string): Promise<string[]> {
    return this.stopWhere(
      projectId,
      (s) => s.workKey === SCOUT_WORK_KEY || s.workKey.startsWith(LENS_WORK_KEY_PREFIX),
    );
  }

  private async stopWhere(projectId: string, which: (s: Session) => boolean): Promise<string[]> {
    const stopped: string[] = [];
    for (const s of this.list(projectId)) {
      if (!LIVE_STATUSES.has(s.status) || !which(s)) continue;
      try {
        await this.deps.sessions.stop(s.id);
        stopped.push(s.id);
      } catch (error) {
        this.deps.log?.(`factory: stop ${s.id}: ${errorMessage(error)}`);
      }
    }
    return stopped;
  }

  /**
   * Factory sessions work on branches of their own, so they ask for a worktree unless they name
   * another workspace: in a project folder that isn't a git repository they are refused
   * (`not_a_repo`), never run in the folder in place.
   */
  private start(req: StartSessionRequestInit): Promise<StartSessionResponse> {
    return this.deps.sessions.start(
      StartSessionRequest.parse({
        role: "agent",
        startedBy: FACTORY_STARTER,
        workspace: { mode: "worktree" },
        ...req,
      }),
    );
  }
}
