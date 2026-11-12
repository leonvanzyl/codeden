import { randomUUID } from "node:crypto";
import type {
  ForkSessionRequest,
  Project,
  ProviderInfo,
  Session,
  WorkspaceRequest,
} from "@codeden/contracts";
import { badRequest, conflict, type ServiceError } from "../errors";
import type { LaunchFork } from "./launcher";
import type { SessionRepo, StoredStartMeta } from "./repo";

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
const TITLE_MAX = 200;
const FORK_SUFFIX = " (fork)";

/** A new session that forks another one, ready to be created and launched. */
export interface ForkPlan {
  session: Session;
  meta: StoredStartMeta;
  workspace: WorkspaceRequest;
  fork: LaunchFork;
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
 * Plan a fork of `source` (§9): a new agent session in the same project with the same
 * provider, model, effort, permissions, work and issue, started by the user. Its worktree
 * branches from the source's branch and starts from the source's latest checkpoint, and the
 * provider forks the conversation (`SessionOptions.forkFrom`, see `SessionLauncher`). There is
 * no §8.4 conflict check: the fork is a deliberate, visible duplicate (`forkedFrom`). The
 * source is only read.
 */
export function planFork(
  deps: { repo: SessionRepo; project: Project; provider: ProviderInfo | undefined },
  source: Session,
  req: ForkSessionRequest,
): ForkPlan {
  const blocker = forkBlocker(source, deps.provider);
  if (blocker) throw blocker;
  const { project } = deps;
  if (project.archivedAt) throw badRequest("The project is archived", "project_archived");
  const checkpoint = deps.repo.latestCheckpointIndex(source.id);
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
    status: "starting",
    cwd: project.path,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    issue: source.issue,
    pr: null,
    resumeToken: null,
    runnerId: null,
    automationRunId: null,
    rootThreadId: null,
    forkedFrom: { sessionId: source.id, checkpoint },
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  return {
    session,
    meta: { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
    workspace: { mode: "worktree", baseRef: source.branch ?? undefined, fetch: false },
    fork: {
      baseBranch: source.baseBranch ?? project.defaultBranch ?? null,
      ...(checkpoint === null
        ? {}
        : { restoreCheckpoint: { sessionId: source.id, index: checkpoint } }),
    },
  };
}
