import { type RoleSessionsRef, type Session, StartSessionRequest } from "@codeden/contracts";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToSession } from "../../db/rows";
import { sessions } from "../../db/schema";
import { ServiceError } from "../errors";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";

export type OrchestrationRole = "orchestrator" | "pm";

/** A role session with a turn starting, running or waiting on the user is left where it is. */
const BUSY = new Set<Session["status"]>(["created", "queued", "starting", "running", "waiting"]);

/**
 * The long-lived role sessions (§8.1): one orchestrator (cwd `<home>/orchestrator/`) and one
 * PM per project (cwd: the project root, read-only). Created lazily on first use; afterwards
 * the same session is reused and, when the runner no longer hosts it, resumed through its
 * provider resume token. Provider, model and effort come from `settings.providers.<role>`.
 *
 * A session can't change provider, so a role moves to another one with a fresh session: when
 * the settings name a provider other than the one the role session runs on, that session is
 * retired (stopped and archived, its transcript kept) once no turn is running, and the next
 * use of the role starts a new one on the chosen provider.
 */
export class RoleSessions {
  private readonly creating = new Map<string, Promise<Session>>();

  constructor(
    private readonly deps: {
      db: Db;
      repo: SessionRepo;
      sessions: SessionService;
      projects: ProjectService;
      log?: (message: string) => void;
    },
  ) {}

  /** The current role session (the latest that isn't retired), if any. */
  find(role: OrchestrationRole, projectId: string | null): Session | undefined {
    if (role === "pm" && !projectId) return undefined;
    const row = this.deps.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.role, role),
          isNull(sessions.archivedAt),
          role === "orchestrator"
            ? isNull(sessions.projectId)
            : eq(sessions.projectId, projectId as string),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1)
      .get();
    return row ? rowToSession(row) : undefined;
  }

  /** Ids of every orchestrator and PM session (to keep them out of work digests). */
  roleSessionIds(): Set<string> {
    const rows = this.deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.role, ["orchestrator", "pm"]))
      .all();
    return new Set(rows.map((r) => r.id));
  }

  /** Current role sessions, for the snapshot. */
  refs(): RoleSessionsRef {
    const rows = this.deps.db
      .select()
      .from(sessions)
      .where(and(inArray(sessions.role, ["orchestrator", "pm"]), isNull(sessions.archivedAt)))
      .orderBy(sessions.createdAt)
      .all()
      .map(rowToSession);
    const ref: RoleSessionsRef = { orchestrator: null, pms: {} };
    for (const s of rows) {
      if (s.role === "orchestrator") ref.orchestrator = s.id;
      else if (s.projectId) ref.pms[s.projectId] = s.id;
    }
    return ref;
  }

  /** The current role sessions: the orchestrator's and every project's PM. */
  private current(): Session[] {
    const ref = this.refs();
    const ids = [ref.orchestrator, ...Object.values(ref.pms)].filter((id) => id !== null);
    return ids.flatMap((id) => this.deps.repo.find(id)?.session ?? []);
  }

  /**
   * The provider the settings now name for this role session, when it is another one than the
   * session runs on (null otherwise, and while the settings leave the choice to Auto).
   */
  private movedTo(session: Session): string | null {
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const wanted = this.deps.sessions.configuredProvider(
      session.role,
      project ? projectDefaultProvider(project) : null,
    );
    return wanted && wanted !== session.provider ? wanted : null;
  }

  /**
   * Retire a role session whose provider is no longer the one the settings name, so the role
   * starts a fresh session there. A session with a turn under way stays until it is checked
   * again. Returns whether it was retired.
   */
  private async retireIfMoved(session: Session): Promise<boolean> {
    if (BUSY.has(session.status) || !this.movedTo(session)) return false;
    await this.deps.sessions.stop(session.id);
    this.deps.repo.update(session.id, (s) =>
      s.archivedAt ? s : { ...s, archivedAt: new Date().toISOString() },
    );
    return true;
  }

  /**
   * Check every role session against the settings (after they change) and retire those whose
   * provider was switched. Their roles show as not started until the next message or wake.
   */
  async applyProviderSettings(): Promise<void> {
    for (const session of this.current()) {
      try {
        await this.retireIfMoved(session);
      } catch (error) {
        this.deps.log?.(`role sessions: could not retire ${session.id}: ${String(error)}`);
      }
    }
  }

  /** The role session, created when missing or when its provider was switched in settings. */
  async ensure(role: OrchestrationRole, projectId: string | null): Promise<Session> {
    const existing = this.find(role, projectId);
    if (existing && !(await this.retireIfMoved(existing))) return existing;
    const key = `${role}:${projectId ?? ""}`;
    let pending = this.creating.get(key);
    if (!pending) {
      pending = this.create(role, projectId).finally(() => this.creating.delete(key));
      this.creating.set(key, pending);
    }
    return pending;
  }

  private async create(role: OrchestrationRole, projectId: string | null): Promise<Session> {
    const project = role === "pm" && projectId ? this.deps.projects.get(projectId) : null;
    if (role === "pm" && !project) {
      throw new ServiceError(400, "project_required", "A PM needs a project");
    }
    const request = StartSessionRequest.parse({
      projectId: role === "pm" ? (projectId as string) : null,
      role,
      workspace: { mode: "repo_root" },
      purpose: project ? `Project manager for ${project.name}` : "Orchestrator",
      workKey: project ? `pm:${project.slug}` : "orchestrator:main",
      startedBy: { kind: "user" },
      title: project ? `PM · ${project.name}` : "Orchestrator",
      autonomy: "auto",
    });
    const result = await this.deps.sessions.start(request);
    if (result.status !== "started") {
      throw new ServiceError(409, "role_session_conflict", `Could not start the ${role} session`);
    }
    const session = this.find(role, projectId);
    if (!session) throw new ServiceError(500, "role_session_missing", "Role session vanished");
    return session;
  }
}
