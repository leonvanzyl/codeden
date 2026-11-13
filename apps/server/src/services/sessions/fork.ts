import { randomUUID } from "node:crypto";
import type {
  ForkSessionRequest,
  Project,
  ProviderInfo,
  Session,
  WorkspaceRequest,
} from "@codeden/contracts";
import { badRequest, conflict, type ServiceError } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, toServiceError } from "../runner-port";
import { confirmedCheckpoint, forkPointMissing, forkTurn } from "./fork-turn";
import type { LaunchFork } from "./launcher";
import type { SessionRepo, StoredStartMeta } from "./repo";

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
const TITLE_MAX = 200;
const FORK_SUFFIX = " (fork)";
/** Writing a checkpoint stages the whole worktree; a big one can take a while. */
const SETTLE_TIMEOUT_MS = 120_000;
/** A provider may start a process to fork (Codex's app-server). */
const FORK_TIMEOUT_MS = 60_000;

/**
 * How a fork's workspace is made (§9), kept with its start metadata until it exists: every
 * start of the session prepares it first, and none runs anywhere else.
 */
export interface ForkStart {
  workspace: WorkspaceRequest;
  fork: LaunchFork;
}

/** A new session that forks another one, ready to be created and launched. */
export interface ForkPlan {
  session: Session;
  meta: StoredStartMeta;
  start: ForkStart;
}

/**
 * Why `source` can't be forked right now, or null when it can. A fork needs an agent session
 * on a provider that reports `capabilities.fork`, with a conversation (a resume token) and a
 * git branch, and no turn running or still to start.
 */
export function forkBlocker(
  source: Session,
  provider: ProviderInfo | undefined,
): ServiceError | null {
  if (source.role !== "agent")
    return badRequest("Only agent sessions can be forked", "fork_unsupported");
  if (!provider?.capabilities.fork) {
    const name = provider?.displayName ?? source.provider;
    return conflict(`${name} cannot fork a conversation`, "unsupported");
  }
  if (source.status === "waiting") {
    return conflict(
      "Answer what the session is waiting on (an approval, a question or its plan) before forking",
      "turn_running",
    );
  }
  if (BUSY.has(source.status)) {
    return conflict("Wait for the running turn to finish before forking", "turn_running");
  }
  if (NOT_STARTED.has(source.status)) {
    return conflict("The session hasn't started yet", "not_started");
  }
  if (!source.resumeToken) {
    return conflict("The session has no conversation to fork yet", "nothing_to_fork");
  }
  if (!source.branch) {
    return conflict("Only sessions that work on a git branch can be forked", "fork_unsupported");
  }
  return null;
}

/** `<source title> (fork)`, kept within the title limit. */
export function forkTitle(source: Session): string {
  const base = (source.title ?? source.purpose).trim();
  return base.length + FORK_SUFFIX.length <= TITLE_MAX
    ? `${base}${FORK_SUFFIX}`
    : `${base.slice(0, TITLE_MAX - FORK_SUFFIX.length).trimEnd()}${FORK_SUFFIX}`;
}

/**
 * Fork `sourceId` (§9). The code and the conversation are taken at the same moment:
 * 1. the source's latest checkpoint, once the runner has written the one for a turn that has
 *    just ended (`checkpoint.list` `settled`);
 * 2. a copy of its conversation, made now by the provider (`provider.fork`).
 * The source is only read. A turn that started meanwhile, even one that has already finished,
 * would make the two disagree, so that fails the fork (`sourceMoved`; the unused copy is left
 * behind, never resumed).
 *
 * With `req.turnId` of an earlier turn ("Fork from here"), the code is that turn's checkpoint
 * and the copy ends with that turn (`upTo`, its fork point). Neither changes once the turn has
 * ended, so later turns don't affect it. The latest turn forks as above. Throws `ServiceError`s.
 */
export async function planFork(
  deps: { repo: SessionRepo; projects: ProjectService; runner: RunnerPort },
  sourceId: string,
  req: ForkSessionRequest,
): Promise<ForkPlan> {
  const { repo, runner } = deps;
  const source = repo.get(sourceId);
  const provider = runner.providers().find((p) => p.id === source.provider);
  const project = forkProject(deps.projects, source, provider);
  const at = req.turnId ? forkTurn(repo, source, req.turnId) : null;
  const earlier = at && !at.latest ? at : null;
  const turns = repo.turnCount(source.id);
  const { checkpoints } = await runner
    .request(
      { name: "checkpoint.list", cwd: project.path, sessionId: source.id, settled: true },
      SETTLE_TIMEOUT_MS,
    )
    .catch(rethrow);
  const checkpoint = earlier
    ? confirmedCheckpoint(
        earlier,
        checkpoints.map((c) => c.index),
      )
    : (checkpoints.at(-1)?.index ?? null);
  const { resumeToken } = await runner
    .request(
      {
        name: "provider.fork",
        providerId: source.provider,
        resumeToken: source.resumeToken as string,
        cwd: project.path,
        ...(earlier ? { upTo: earlier.upTo } : {}),
      },
      FORK_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      throw forkPointMissing(error) ?? toServiceError(error);
    });
  if (!earlier) {
    const late = sourceMoved(repo, source, turns, provider);
    if (late) throw late;
  }
  const origin = { checkpoint, resumeToken, turnId: at?.turnId, turnNumber: at?.turnNumber };
  return forkPlan(source, project, origin, req);
}

/**
 * Whether the source moved on while it was being forked: a turn running now, or one that
 * started (and maybe finished) since `turns` was counted, or a new conversation. The copy
 * could then hold a turn the checkpoint doesn't.
 */
function sourceMoved(
  repo: SessionRepo,
  source: Session,
  turns: number,
  provider: ProviderInfo | undefined,
): ServiceError | null {
  const now = repo.get(source.id);
  const blocker = forkBlocker(now, provider);
  if (blocker) return blocker;
  if (repo.turnCount(source.id) !== turns || now.resumeToken !== source.resumeToken) {
    return conflict(
      "The session ran a turn while it was being forked. Fork it again.",
      "source_changed",
    );
  }
  return null;
}

/** The source's project, after checking the source can be forked at all. */
function forkProject(
  projects: ProjectService,
  source: Session,
  provider: ProviderInfo | undefined,
): Project {
  const blocker = forkBlocker(source, provider);
  if (blocker) throw blocker;
  if (!source.projectId) throw badRequest("Only agent sessions can be forked", "fork_unsupported");
  const project = projects.get(source.projectId);
  if (project.archivedAt) throw badRequest("The project is archived", "project_archived");
  return project;
}

/**
 * The fork itself: a new agent session in the same project with the same provider, model,
 * effort, permissions, plan mode, work and issue, started by the user, with its own copy of the
 * conversation (`resumeToken`). Its worktree branches from the source's branch and starts from
 * `checkpoint`; its pull request targets the source's base branch. There is no §8.4 conflict
 * check: the fork is a deliberate, visible duplicate (`forkedFrom`, with the turn it was taken
 * at when one was named).
 */
export function forkPlan(
  source: Session,
  project: Project,
  origin: {
    checkpoint: number | null;
    resumeToken: string;
    turnId?: string;
    /** The source's turn number of `turnId` (1 is its first); 0 or absent when unknown. */
    turnNumber?: number;
  },
  req: ForkSessionRequest,
): ForkPlan {
  const { checkpoint, turnId, turnNumber } = origin;
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    projectId: project.id,
    role: "agent",
    parentSessionId: null,
    startedBy: { kind: "user" },
    purpose: source.purpose,
    workKey: source.workKey,
    scope: source.scope,
    progress: null,
    title: req.title ?? forkTitle(source),
    provider: source.provider,
    model: source.model,
    effort: source.effort,
    autonomy: source.autonomy,
    // The fork continues the same conversation: still planning if the source is, implementing
    // (at its permission level) if the source's plan was approved.
    planMode: source.planMode ?? false,
    status: "starting",
    cwd: project.path,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    issue: source.issue,
    pr: null,
    resumeToken: origin.resumeToken,
    // The copied conversation and checkpoint live on the source's runner: the fork runs there.
    runnerId: source.runnerId,
    automationRunId: null,
    rootThreadId: null,
    forkedFrom: {
      sessionId: source.id,
      checkpoint,
      ...(turnId ? { turnId } : {}),
      ...(turnId && turnNumber ? { turnNumber } : {}),
    },
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const start: ForkStart = {
    workspace: { mode: "worktree", baseRef: source.branch ?? undefined, fetch: false },
    fork: {
      baseBranch: source.baseBranch ?? project.defaultBranch ?? null,
      ...(checkpoint === null
        ? {}
        : { restoreCheckpoint: { sessionId: source.id, index: checkpoint } }),
    },
  };
  return {
    session,
    start,
    meta: {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
      forkStart: start,
    },
  };
}

function rethrow(error: unknown): never {
  throw toServiceError(error);
}
