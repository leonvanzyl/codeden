import {
  isActiveSession,
  type QueuedMessage,
  type RoleSessionsRef,
  type Session,
  type Settings,
  StartSessionRequest,
} from "@codeden/contracts";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToSession } from "../../db/rows";
import { sessions } from "../../db/schema";
import type { SettingsStore } from "../../settings-store";
import { ServiceError } from "../errors";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo, StoredStartMeta } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";

export type OrchestrationRole = "orchestrator" | "pm";

const EMPTY_META: StoredStartMeta = {
  workspaceMode: "repo_root",
  workspaceFallback: null,
  forced: null,
  queuedBehind: [],
};

const keyOf = (role: OrchestrationRole, projectId: string | null) => `${role}:${projectId ?? ""}`;

/**
 * The long-lived role sessions (§8.1): one orchestrator (cwd `<home>/orchestrator/`) and one
 * PM per project (cwd: the project root, read-only). Created lazily on first use; afterwards
 * the same session is reused and, when the runner no longer hosts it, resumed through its
 * provider resume token. Provider, model and effort come from `settings.providers.<role>`.
 *
 * A session can't change provider, so a role moves to another one with a fresh session: when
 * the role's provider setting is changed to a provider other than the one the role session
 * runs on, that session is retired (stopped and archived, its transcript kept) once no turn is
 * running, and the next use of the role starts a new one on the chosen provider. Messages
 * waiting in the retired session's queue move to the new one, which is then started at once.
 */
export class RoleSessions {
  /** The change of a role's session under way (retire, create or both), by role key. */
  private readonly changing = new Map<string, Promise<Session | undefined>>();
  /**
   * Role sessions retired with nothing to hand over, by role key, until the role's next session
   * is created: `onMoved` then names the session it replaces.
   */
  private readonly retired = new Map<string, Session>();
  /** The last `applyProviderSettings` run: they follow each other. */
  private applying: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      db: Db;
      repo: SessionRepo;
      sessions: SessionService;
      inbox: Pick<InboxService, "list" | "close">;
      projects: ProjectService;
      settings: Pick<SettingsStore, "get">;
      /** The home runner: its providers are the ones a role can move to. */
      runner: Pick<RunnerPort, "isConnected" | "providers">;
      /** A role's retired session was replaced by a new one (which took over its queue). */
      onMoved?: (from: Session, to: Session) => void;
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
   * The provider this role session moves to, or null while it stays. Only a change of the role's
   * own setting (`settings.providers.<role>.provider`) moves a session: it is compared with the
   * value the session was started under (`StoredStartMeta.roleProvider`). A project's default
   * provider changing, or a session from before that value was recorded, moves nothing.
   *
   * A changed setting that doesn't move the session is settled (recorded as seen) when it
   * leaves the choice to Auto, or when a new session would start on the provider this one
   * already runs on. It stays open while it can't be judged: the runner is away, so its
   * providers aren't known, or it doesn't have the named provider (yet).
   */
  private moveTarget(session: Session): string | null {
    const under = this.deps.repo.find(session.id)?.startMeta?.roleProvider;
    const setting = this.deps.settings.get().providers[session.role].provider;
    if (under === undefined || under === setting) return null;
    const { runner } = this.deps;
    if (!runner.isConnected()) return null;
    if (setting !== "auto" && !runner.providers().some((p) => p.id === setting)) return null;
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const target =
      setting === "auto"
        ? null
        : this.deps.sessions.configuredProvider(
            session.role,
            project ? projectDefaultProvider(project) : null,
          );
    if (target && target !== session.provider) return target;
    this.recordSetting(session.id, setting);
    return null;
  }

  private recordSetting(sessionId: string, roleProvider: string): void {
    this.deps.repo.setStartMeta(sessionId, (meta) => ({ ...(meta ?? EMPTY_META), roleProvider }));
  }

  /** Whether the session is to be retired now: its role moved, and no turn is under way. */
  private shouldRetire(session: Session): boolean {
    const underWay = isActiveSession(session) || this.deps.sessions.isDelivering(session.id);
    return !underWay && this.moveTarget(session) !== null;
  }

  /**
   * Retire a role session (stop and archive it, its transcript kept) and return the messages
   * that were waiting in its queue, which move to the role's new session. Its open approvals
   * and questions are dismissed, as stopping any session does. Its open failed runs are
   * dismissed too: their Retry messages the session, which would bring the retired
   * conversation back on the old provider.
   */
  private async retire(session: Session): Promise<QueuedMessage[]> {
    const queued = await this.deps.sessions.stopKeepingQueue(session.id);
    for (const item of this.deps.inbox.list({ sessionId: session.id })) {
      if (item.kind !== "run_failed") continue;
      this.deps.inbox.close(item, "dismissed", { reason: "moved to another provider" });
    }
    this.deps.repo.update(session.id, (s) =>
      s.archivedAt ? s : { ...s, archivedAt: new Date().toISOString() },
    );
    return queued;
  }

  /**
   * Retire `existing` (when given) and start the role's new session, which takes over the
   * queued messages in their order, each with its sender. With `always` false a new session
   * is started only when there is something to hand over; otherwise the role shows as not
   * started until its next message or wake.
   *
   * If the new session can't be started, the messages go back to the old one, which stays the
   * role's session: nothing queued is lost, and the move is tried again on the next use.
   */
  private async replace(
    existing: Session | undefined,
    role: OrchestrationRole,
    projectId: string | null,
    always: boolean,
  ): Promise<Session | undefined> {
    const key = keyOf(role, projectId);
    const queued = existing ? await this.retire(existing) : [];
    if (existing) this.retired.set(key, existing);
    if (!always && queued.length === 0) return undefined;
    let created: Session;
    try {
      created = await this.create(role, projectId);
    } catch (error) {
      if (existing && queued.length > 0) {
        this.deps.repo.update(existing.id, (s) => ({ ...s, archivedAt: null }));
        this.deps.sessions.restoreQueued(queued);
        this.retired.delete(key);
      }
      throw error;
    }
    this.deps.sessions.adoptQueued(created.id, queued);
    const replaced = this.retired.get(key);
    this.retired.delete(key);
    if (replaced) this.deps.onMoved?.(replaced, created);
    return created;
  }

  /**
   * Run `work` as the one change of this role's session: until it ends, every `ensure` of the
   * role waits for it instead of retiring or creating a session of its own.
   */
  private exclusive(
    key: string,
    work: () => Promise<Session | undefined>,
  ): Promise<Session | undefined> {
    const run = work().finally(() => this.changing.delete(key));
    this.changing.set(key, run);
    return run;
  }

  /**
   * The settings changed: retire the role sessions whose provider was switched, one after the
   * other. A session with a turn under way (or on its way to the runner) stays until it is
   * checked again, on the role's next message or wake. `previous` is the provider settings
   * before the change: a role session from before the setting was recorded on sessions takes
   * its value from there, so this change moves it like any other.
   *
   * The settings request doesn't wait for the returned promise (stopping a session can take a
   * while); it never rejects, and failures are logged.
   */
  applyProviderSettings(previous?: Settings["providers"]): Promise<void> {
    if (previous) {
      for (const session of this.current()) {
        if (this.deps.repo.find(session.id)?.startMeta?.roleProvider !== undefined) continue;
        this.recordSetting(session.id, previous[session.role].provider);
      }
    }
    const run = this.applying.then(() => this.retireMoved());
    this.applying = run;
    return run;
  }

  private async retireMoved(): Promise<void> {
    const ref = this.refs();
    const roles: [OrchestrationRole, string | null][] = [
      ["orchestrator", null],
      ...Object.keys(ref.pms).map((id): [OrchestrationRole, string] => ["pm", id]),
    ];
    for (const [role, projectId] of roles) {
      try {
        const key = keyOf(role, projectId);
        // A change of this role's session is under way: it checked the settings itself.
        if (this.changing.has(key)) continue;
        const session = this.find(role, projectId);
        if (!session || !this.shouldRetire(session)) continue;
        await this.exclusive(key, () => this.replace(session, role, projectId, false));
      } catch (error) {
        this.deps.log?.(`role sessions: could not move the ${role} session: ${String(error)}`);
      }
    }
  }

  /**
   * The role session, created when missing or when its provider was switched in settings.
   * Retiring the old session and creating the new one are a single change under the role's
   * key: nothing is awaited between looking the session up and taking the key, so concurrent
   * callers (a wake and a message just after the setting changed) all get the same session.
   */
  async ensure(role: OrchestrationRole, projectId: string | null): Promise<Session> {
    const key = keyOf(role, projectId);
    for (;;) {
      const pending = this.changing.get(key);
      if (pending) {
        // A retirement that started no session leaves the role to be created here.
        const session = await pending;
        if (session) return session;
        continue;
      }
      const existing = this.find(role, projectId);
      if (existing && !this.shouldRetire(existing)) return existing;
      const session = await this.exclusive(key, () =>
        this.replace(existing, role, projectId, true),
      );
      if (session) return session;
    }
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
