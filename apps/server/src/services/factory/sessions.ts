import {
  type DiscoveryArea,
  type FactoryItem,
  type Session,
  type StartedBy,
  StartSessionRequest,
  type StartSessionRequestInit,
  type StartSessionResponse,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { builderPrompt, revertPrompt, reviewerPrompt } from "./prompts";

/** Who starts factory sessions; `id: "factory"` marks them for limits and the kill switch. */
export const FACTORY_STARTER: StartedBy = { kind: "pm", id: "factory" };

/** Statuses that hold a session slot (`maxConcurrentSessions`). */
const SLOT_STATUSES = new Set(["created", "queued", "starting", "running", "waiting"]);
/** Statuses of sessions the kill switch stops. */
const LIVE_STATUSES = new Set([...SLOT_STATUSES, "idle", "interrupted"]);

export function isFactorySession(s: Session): boolean {
  return s.startedBy.kind === FACTORY_STARTER.kind && s.startedBy.id === FACTORY_STARTER.id;
}

/** Work key of the dark factory's scout (one long-lived session per project). */
export const SCOUT_WORK_KEY = "factory:scout";
/** Work key prefix of the scout's lenses (one long-lived session per area). */
export const LENS_WORK_KEY_PREFIX = "factory:lens:";

/** Whether a session is busy with a turn (or about to start one). */
export function isBusy(s: Session): boolean {
  return SLOT_STATUSES.has(s.status);
}

export interface FactorySessionsDeps {
  sessions: SessionService;
  repo: SessionRepo;
  runner: RunnerPort;
  log?: (message: string) => void;
}

/** Starts and stops the factory's agent sessions through the normal session service (§8.2). */
export class FactorySessions {
  constructor(private readonly deps: FactorySessionsDeps) {}

  /** Factory sessions of a project, newest first. */
  list(projectId: string): Session[] {
    return this.deps.repo.list({ projectId, role: "agent" }).filter(isFactorySession);
  }

  /** Factory sessions holding a slot right now. */
  activeCount(projectId: string): number {
    return this.list(projectId).filter((s) => SLOT_STATUSES.has(s.status)).length;
  }

  /** Providers the runner offers (the Fake provider only when nothing else is there). */
  providers(): string[] {
    const ids = this.deps.runner.providers().map((p) => p.id);
    const real = ids.filter((id) => id !== "fake");
    return real.length > 0 ? real : ids;
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
      input: { text, attachments: [] },
    });
  }

  /** Start one of the scout's lenses (long-lived, one per area). */
  startLens(projectId: string, area: DiscoveryArea, text: string): Promise<StartSessionResponse> {
    return this.start({
      projectId,
      purpose: `Factory lens: review ${area.replace("_", " ")}`,
      workKey: `${LENS_WORK_KEY_PREFIX}${area}`,
      scope: { area: `factory-lens-${area}` },
      title: `Factory lens: ${area.replace("_", " ")}`,
      input: { text, attachments: [] },
    });
  }

  startBuilder(item: FactoryItem, vision: string, provider: string): Promise<StartSessionResponse> {
    const step = item.type ? ` (${item.type})` : "";
    return this.start({
      projectId: item.projectId,
      provider,
      purpose: `Factory${step}: ${item.title}`.slice(0, 300),
      workKey: item.workKey,
      title: item.title.slice(0, 200),
      issue: item.issue ?? undefined,
      input: { text: builderPrompt(item, vision), attachments: [] },
    });
  }

  /**
   * Start the reviewer offline: in the builder's worktree when there is one, otherwise (a
   * revert PR opened through the API) in a new worktree on the PR's head, fetched from origin
   * by CodeDen before the session starts.
   */
  startReviewer(
    item: FactoryItem,
    vision: string,
    provider: string,
    note: string | null,
    pr: { headBranch: string; baseBranch: string } | null,
    autoMerge: boolean,
  ): Promise<StartSessionResponse> {
    const builder = item.builderSessionId
      ? this.deps.repo.find(item.builderSessionId)?.session
      : undefined;
    const worktree = builder?.worktreePath ?? null;
    let workspace: StartSessionRequest["workspace"] = { mode: "worktree" };
    let localBase: string | null = null;
    if (worktree) {
      workspace = { mode: "existing", path: worktree };
      localBase = builder?.baseBranch ?? "main";
    } else if (pr) {
      workspace = {
        mode: "worktree",
        branch: `codeden/review-${item.pr?.number ?? item.id.slice(0, 8)}-${item.id.slice(0, 4)}`,
        baseRef: `origin/${pr.headBranch}`,
        fetch: true,
      };
      localBase = `origin/${pr.baseBranch}`;
    }
    return this.start({
      projectId: item.projectId,
      provider,
      purpose: `Factory review: ${item.title}`.slice(0, 300),
      workKey: `factory:review:${item.pr?.number ?? item.id}`,
      title: `Review: ${item.title}`.slice(0, 200),
      issue: item.issue ?? undefined,
      workspace,
      input: { text: reviewerPrompt(item, vision, note, localBase, autoMerge), attachments: [] },
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
      input: { text: revertPrompt(merge), attachments: [] },
    });
  }

  /** Send a follow-up to a session (queued behind a running turn). */
  async message(sessionId: string, text: string): Promise<void> {
    await this.deps.sessions.send(
      sessionId,
      { input: { text, attachments: [] }, whenBusy: "queue" },
      "codeden",
    );
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
