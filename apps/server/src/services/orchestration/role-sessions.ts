import {
  isActiveSession,
  type QueuedMessage,
  type RoleSessionsRef,
  type Session,
  type Settings,
  StartSessionRequest,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { SettingsStore } from "../../settings-store";
import { conflict, ServiceError } from "../errors";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import { assertProjectActive } from "../sessions/archived-project";
import type { SessionRepo, StoredStartMeta } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { limitReset, type RoleFallback } from "./role-fallback";
import { freshRefusal, isOpenRequest } from "./role-fresh";
import { allRoleSessionIds, findRoleSession, roleSessionRefs } from "./role-queries";

export type OrchestrationRole = "orchestrator" | "pm";

/**
 * Why a role's session is replaced: its provider setting moved, a person started fresh, its
 * provider hit its usage limit (`limit`), or that limit has reset and the role goes back.
 */
export type ReplaceReason = "moved" | "fresh" | "limit" | "reset";

/** A fallback after a usage limit: the provider that takes over, and the message to send again. */
export interface FallbackPlan {
  provider: string;
  fallback: RoleFallback;
  /** The message of the turn that failed, sent first on the new session. */
  first?: Pick<QueuedMessage, "input" | "from">;
}

/** How a role's session is replaced: why, and where the new one starts when not as settings say. */
type Replacement = { why: ReplaceReason } & Partial<FallbackPlan>;

const MOVED: Replacement = { why: "moved" };

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
 * A person can also start the role over ("Start fresh", `startFresh`): the same change, with
 * the new session started at once. A retired session stays archived and read-only.
 *
 * With `settings.providers.autoSwitchOnLimit`, a role whose provider hit its usage limit moves
 * to a fallback provider the same way (`fallBack`, called by `RoleLimitSwitch`), and its next
 * use after the limit has reset moves it back.
 */
export class RoleSessions {
  /** The change of a role's session under way (retire, create or both), by role key. */
  private readonly changing = new Map<string, Promise<Session | undefined>>();
  /**
   * Role sessions retired with nothing to hand over, by role key, until the role's next session
   * is created: `onMoved` then names the session it replaces.
   */
  private readonly retired = new Map<string, { session: Session; plan: Replacement }>();
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
      onMoved?: (from: Session, to: Session, why: ReplaceReason) => void;
      now?: () => number;
      log?: (message: string) => void;
    },
  ) {}

  /** The current role session (the latest that isn't retired), if any. */
  find(role: OrchestrationRole, projectId: string | null): Session | undefined {
    return findRoleSession(this.deps.db, role, projectId);
  }

  /** Ids of every orchestrator and PM session (to keep them out of work digests). */
  roleSessionIds(): Set<string> {
    return allRoleSessionIds(this.deps.db);
  }

  /** Current role sessions, for the snapshot. */
  refs(): RoleSessionsRef {
    return roleSessionRefs(this.deps.db);
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

  /** Record the setting a session was checked against; a fallback it ran as ends with it. */
  private recordSetting(sessionId: string, roleProvider: string): void {
    this.deps.repo.setStartMeta(sessionId, (meta) => ({
      ...(meta ?? EMPTY_META),
      roleProvider,
      fallback: null,
    }));
  }

  /** Whether the runner has `provider` and it isn't turned off in Settings → Providers. */
  private loaded(provider: string): boolean {
    return (
      this.deps.runner.providers().some((p) => p.id === provider) &&
      !this.deps.settings.get().providers.disabled.includes(provider)
    );
  }

  /**
   * How the session is to be replaced now, or null while it stays: its role's setting moved, or
   * it runs on a fallback whose limit has reset (back to the provider it left, if the runner
   * still has it, else as settings say). Never while a turn is under way.
   */
  private retirement(session: Session): Replacement | null {
    if (isActiveSession(session) || this.deps.sessions.isDelivering(session.id)) return null;
    if (this.moveTarget(session) !== null) return MOVED;
    const fallback = this.deps.repo.find(session.id)?.startMeta?.fallback;
    if (!fallback || !this.deps.runner.isConnected()) return null;
    if (!limitReset(fallback, this.deps.now?.() ?? Date.now())) return null;
    return { why: "reset", provider: fallback.home };
  }

  /**
   * Retire a role session (stop and archive it, its transcript kept) and return the messages
   * that were waiting in its queue, which move to the role's new session. Its open approvals
   * and questions are dismissed, as stopping any session does. Its open failed runs are
   * dismissed too: their Retry would message the retired conversation, which stays archived.
   */
  private async retire(session: Session, why: ReplaceReason): Promise<QueuedMessage[]> {
    const queued = await this.deps.sessions.stopKeepingQueue(session.id);
    const reason = why === "fresh" ? "started fresh" : "moved to another provider";
    for (const item of this.deps.inbox.list({ sessionId: session.id })) {
      if (item.kind !== "run_failed") continue;
      this.deps.inbox.close(item, "dismissed", { reason });
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
   * role's session: nothing queued is lost, and the move is tried again on the next use. A
   * fresh start or a fallback (`why` "fresh", "limit") that can't begin always leaves the old
   * session as it was.
   */
  private async replace(
    existing: Session | undefined,
    role: OrchestrationRole,
    projectId: string | null,
    always: boolean,
    given: Replacement = MOVED,
  ): Promise<Session | undefined> {
    const key = keyOf(role, projectId);
    const queued = existing ? await this.retire(existing, given.why) : [];
    if (existing) this.retired.set(key, { session: existing, plan: given });
    if (!always && queued.length === 0) return undefined;
    // A role retired earlier with nothing to hand over is created as that change planned it.
    const replaced = this.retired.get(key);
    const plan = existing ? given : (replaced?.plan ?? given);
    let created: Session;
    try {
      created = await this.create(role, projectId, plan);
    } catch (error) {
      if (existing && (queued.length > 0 || given.why === "fresh" || given.why === "limit")) {
        this.deps.repo.update(existing.id, (s) => ({ ...s, archivedAt: null }));
        this.deps.sessions.restoreQueued(queued);
        this.retired.delete(key);
      }
      throw error;
    }
    this.deps.sessions.adoptQueued(created.id, [...(plan.first ? [plan.first] : []), ...queued]);
    this.retired.delete(key);
    if (replaced) this.deps.onMoved?.(replaced.session, created, plan.why);
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
        const plan = session && this.retirement(session);
        if (!session || !plan) continue;
        await this.exclusive(key, () => this.replace(session, role, projectId, false, plan));
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
      const plan = existing && this.retirement(existing);
      if (existing && !plan) return existing;
      const session = await this.exclusive(key, () =>
        this.replace(existing, role, projectId, true, plan ?? MOVED),
      );
      if (session) return session;
    }
  }

  /**
   * The role's provider hit its usage limit (§8.1): replace `session`, the role's current one,
   * with a new one on `plan.provider`, as one step with a provider move, and send the failed
   * turn's message again there, ahead of what waited in the queue. Undefined (nothing changed)
   * when the session is no longer the role's, is changing, or runs a turn again.
   */
  async fallBack(session: Session, plan: FallbackPlan): Promise<Session | undefined> {
    const role = session.role as OrchestrationRole;
    const key = keyOf(role, session.projectId);
    const current = this.find(role, session.projectId);
    if (this.changing.has(key) || current?.id !== session.id) return undefined;
    if (isActiveSession(current) || this.deps.sessions.isDelivering(current.id)) return undefined;
    return this.exclusive(key, () =>
      this.replace(current, role, session.projectId, true, { why: "limit", ...plan }),
    );
  }

  /**
   * "Start fresh" (§8.1, a person's action): archive the role's current session (stopped, its
   * transcript kept, read-only) and start a new one under the same work key, on the provider
   * and model the settings name. It is the same single change as a provider move (`replace`),
   * so a message or wake meanwhile waits for it and gets the new session; messages waiting in
   * the old session's queue move over. Refused while a turn runs or a question or approval is
   * open (`freshRefusal`), and when `sessionId` is no longer the role's current session (a
   * second click, or the role changed meanwhile).
   */
  async startFresh(
    role: OrchestrationRole,
    projectId: string | null,
    sessionId: string,
  ): Promise<{ session: Session; archived: Session }> {
    const key = keyOf(role, projectId);
    const name = role === "pm" ? "PM" : "orchestrator";
    if (this.changing.has(key)) {
      throw conflict(`The ${name}'s session is changing right now. Try again in a moment.`);
    }
    const existing = this.find(role, projectId);
    if (!existing || existing.id !== sessionId) {
      throw conflict(`This is no longer the ${name}'s current conversation`, "not_current");
    }
    // An archived project's PM is read-only: refused before anything is stopped.
    assertProjectActive(this.deps.projects, existing);
    const refusal = freshRefusal(existing, {
      delivering: this.deps.sessions.isDelivering(existing.id),
      openRequests: this.deps.inbox.list({ sessionId: existing.id }).filter(isOpenRequest).length,
    });
    if (refusal) throw refusal;
    const session = await this.exclusive(key, () =>
      this.replace(existing, role, projectId, true, { why: "fresh" }),
    );
    if (!session) throw new ServiceError(500, "role_session_missing", "Role session vanished");
    return { session, archived: this.deps.repo.get(existing.id) };
  }

  /** Start the role's session: as settings say, or on the plan's provider while it is loaded. */
  private async create(
    role: OrchestrationRole,
    projectId: string | null,
    plan: Replacement = MOVED,
  ): Promise<Session> {
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
      ...(plan.provider && this.loaded(plan.provider) && { provider: plan.provider }),
    });
    const result = await this.deps.sessions.start(request);
    if (result.status !== "started") {
      throw new ServiceError(409, "role_session_conflict", `Could not start the ${role} session`);
    }
    const session = this.find(role, projectId);
    if (!session) throw new ServiceError(500, "role_session_missing", "Role session vanished");
    const { fallback } = plan;
    // Back on the provider it left (its limit reset before the fallback's own): no fallback now.
    if (fallback && session.provider === plan.provider && session.provider !== fallback.home) {
      this.deps.repo.setStartMeta(session.id, (meta) => ({ ...(meta ?? EMPTY_META), fallback }));
    }
    return session;
  }
}
