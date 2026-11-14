import type {
  Checkpoint,
  DiffResult,
  DiffScope,
  GitCommitRequest,
  GitCommitResponse,
  GitPushRequest,
  GitPushResponse,
  GitStatusResponse,
  RestoreFilesRequest,
  RestoreFilesResponse,
  Session,
} from "@codeden/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { checkpoints } from "../../db/schema";
import { badRequest, conflict, notFound } from "../errors";
import type { GitBroker } from "../git-broker";
import type { ProjectService } from "../projects/project-service";
import { type RunnerDeps, type RunnerPort, runnerForSession, toServiceError } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import { sessionWorkdir } from "../sessions/workdir";
import { statsFromPatch, toDiffFiles } from "./diff-files";

const GIT_TIMEOUT_MS = 120_000;

function rethrow(error: unknown): never {
  throw toServiceError(error);
}

/**
 * Checkpoints, diffs and git for a session's worktree (§9, §12.3), backed by the `checkpoint.*`
 * and `git.*` commands of the runner that hosts it. Turn diffs compare consecutive
 * checkpoints; the session diff compares the baseline with the live working tree, and a
 * compare diff another session's latest checkpoint with it.
 */
export class WorkbenchService {
  constructor(
    private readonly deps: RunnerDeps & {
      db: Db;
      repo: SessionRepo;
      /** With `git`: the push credential for a runner that doesn't share this disk (§9.2). */
      projects?: Pick<ProjectService, "get">;
      git?: GitBroker;
    },
  ) {}

  /** The runner that hosts the session's worktree. */
  private runner(sessionId: string): RunnerPort {
    return runnerForSession(this.deps, sessionId);
  }

  checkpoints(sessionId: string): Checkpoint[] {
    this.deps.repo.get(sessionId);
    return this.deps.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId))
      .orderBy(asc(checkpoints.index))
      .all();
  }

  async diff(sessionId: string, scope: DiffScope): Promise<DiffResult> {
    const session = this.deps.repo.get(sessionId);
    const cwd = workdir(session);
    const all = this.checkpoints(sessionId);
    const turns = all
      .filter((c) => c.turnId !== null)
      .map((c) => ({
        id: c.turnId as string,
        index: c.index,
        label: `Turn ${c.index}`,
        at: c.createdAt,
      }));

    if (scope.kind === "uncommitted") {
      const result = await this.runner(sessionId)
        .request({ name: "git.diff", cwd, fromRef: "HEAD" }, GIT_TIMEOUT_MS)
        .catch(rethrow);
      return {
        scope,
        turns,
        files: toDiffFiles(result.diff, result.files ?? statsFromPatch(result.diff)),
      };
    }
    if (scope.kind === "compare") {
      return { scope, turns, ...(await this.compare(session, cwd, scope.sessionId)) };
    }
    if (all.length === 0) {
      throw conflict("This session has no checkpoints yet", "no_checkpoints");
    }
    let from: number;
    let to: number | undefined;
    if (scope.kind === "session") {
      from = all[0]?.index ?? 0;
    } else {
      const target = all.find((c) => c.turnId === scope.turnId);
      if (!target) throw notFound("No checkpoint for that turn", "checkpoint_not_found");
      const previous = all.filter((c) => c.index < target.index).at(-1);
      from = previous?.index ?? target.index;
      to = target.index;
    }
    const result = await this.runner(sessionId)
      .request({ name: "checkpoint.diff", cwd, sessionId, from, to }, GIT_TIMEOUT_MS)
      .catch(rethrow);
    return { scope, turns, files: toDiffFiles(result.diff, result.files) };
  }

  /**
   * Another session's latest checkpoint against this session's working tree (§12.3): `+` lines
   * are this session's, `−` lines the other's. Both must be in one project on one runner, where
   * worktrees share the repository's refs and objects, so the other's checkpoint commit is
   * readable from this worktree.
   */
  private async compare(
    session: Session,
    cwd: string,
    otherId: string,
  ): Promise<Pick<DiffResult, "files" | "against">> {
    if (otherId === session.id) {
      throw badRequest("Pick another session to compare with", "compare_same_session");
    }
    const other = this.deps.repo.get(otherId);
    const name = other.title ?? other.purpose;
    if (!session.projectId || other.projectId !== session.projectId) {
      throw badRequest(
        "Only sessions of the same project can be compared",
        "compare_other_project",
      );
    }
    const runner = this.runner(session.id);
    if (this.runner(other.id) !== runner) {
      throw conflict(
        `"${name}" runs on another runner, so its code can't be compared with this session's`,
        "compare_other_runner",
      );
    }
    const latest = this.checkpoints(other.id).at(-1);
    if (!latest) throw conflict(`"${name}" has no checkpoints yet`, "no_checkpoints");
    const result = await runner
      .request({ name: "git.diff", cwd, fromRef: latest.commit }, GIT_TIMEOUT_MS)
      .catch(rethrow);
    return {
      files: toDiffFiles(result.diff, result.files ?? statsFromPatch(result.diff)),
      against: { sessionId: other.id, index: latest.index, at: latest.createdAt },
    };
  }

  /** Restore files to a checkpoint; `turnId` means the state before that turn. */
  async restore(sessionId: string, req: RestoreFilesRequest): Promise<RestoreFilesResponse> {
    const session = this.deps.repo.get(sessionId);
    let index = req.index;
    if (req.turnId !== undefined) {
      const all = this.checkpoints(sessionId);
      const target = all.find((c) => c.turnId === req.turnId);
      if (!target) throw notFound("No checkpoint for that turn", "checkpoint_not_found");
      index = all.filter((c) => c.index < target.index).at(-1)?.index;
      if (index === undefined) throw badRequest("No checkpoint before that turn", "no_baseline");
    }
    if (index === undefined) throw badRequest("Pass turnId or index");
    const result = await this.runner(sessionId)
      .request(
        {
          name: "checkpoint.restoreFiles",
          cwd: workdir(session),
          sessionId,
          index,
          paths: req.paths,
        },
        GIT_TIMEOUT_MS,
      )
      .catch(rethrow);
    return { index, ...result };
  }

  async status(sessionId: string): Promise<GitStatusResponse> {
    const session = this.deps.repo.get(sessionId);
    const result = await this.runner(sessionId)
      .request({ name: "git.status", cwd: workdir(session) }, GIT_TIMEOUT_MS)
      .catch(rethrow);
    return { ...result, baseBranch: session.baseBranch };
  }

  async commit(sessionId: string, req: GitCommitRequest): Promise<GitCommitResponse> {
    const session = this.deps.repo.get(sessionId);
    return this.runner(sessionId)
      .request({ name: "git.commit", cwd: workdir(session), ...req }, GIT_TIMEOUT_MS)
      .catch(rethrow);
  }

  async push(sessionId: string, req: GitPushRequest): Promise<GitPushResponse> {
    const session = this.deps.repo.get(sessionId);
    const runner = this.runner(sessionId);
    // The token goes with a push to the session's own `origin` only, never to another remote.
    const toOrigin = (req.remote ?? "origin") === "origin";
    const project =
      toOrigin && session.projectId ? (this.deps.projects?.get(session.projectId) ?? null) : null;
    const credential = await this.deps.git?.credentialForProject(runner, project);
    return runner
      .request(
        {
          name: "git.push",
          cwd: workdir(session),
          remote: req.remote,
          forceWithLease: req.forceWithLease,
          ...(credential ? { credential } : {}),
        },
        GIT_TIMEOUT_MS,
      )
      .catch(rethrow);
  }
}

/** Directory git commands run in: the session's worktree, else its cwd. */
export function workdir(session: Session): string {
  return sessionWorkdir(session);
}
