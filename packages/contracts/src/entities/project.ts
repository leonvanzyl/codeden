import { z } from "zod";
import { AutonomyLevel, Id, ProviderId, ReasoningEffort, Timestamp } from "../common";
import { ProjectExecution } from "../execution";
import { AutonomyMode, DEFAULT_VISION_PATH, FactoryLimits } from "../factory";

/**
 * Something re-detecting a project's folder found that CodeDen does not apply on its own (§9).
 * `github_remote_missing`: a `github` project's folder no longer has a GitHub `origin` (removed,
 * pointing at another host, or no git checkout at all). The project keeps its GitHub
 * coordinates until the user restores the remote or disconnects GitHub.
 */
export const ProjectRemoteWarning = z.object({
  code: z.literal("github_remote_missing"),
  /** What `origin` points at now, credentials removed; null when there is no `origin`. */
  remoteUrl: z.string().nullable(),
  detectedAt: Timestamp,
});
export type ProjectRemoteWarning = z.infer<typeof ProjectRemoteWarning>;

const projectBase = {
  id: Id,
  name: z.string().min(1),
  /** Short, filesystem-safe name used in worktree paths (`wt/<slug>/...`). */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** Absolute path of the main checkout. */
  path: z.string().min(1),
  /**
   * The project folder is a git repository (§9). Detected when the project is added and on every
   * re-detection (server start, after turns in local-only projects, on demand). A folder that
   * isn't one has no worktrees: its sessions run in the folder itself, and a worktree asked for
   * is refused when the session is created (`not_a_repo`). Defaults to true so events written
   * before it existed still parse; the next server start detects it again, and a session start in
   * a project that check hasn't reached yet waits for its check of the folder.
   */
  isGitRepo: z.boolean().default(true),
  defaultBranch: z.string().nullable(),
  /** Overrides the global default provider for new agent sessions. */
  defaultProvider: ProviderId.nullable(),
  /**
   * The model new sessions in this project start on when they run on `defaultProvider` (a
   * provider's model id, custom ids included). Null: Settings > Providers > Agent sessions, else
   * the provider's own default. Cleared when `defaultProvider` changes without a new model. Read by
   * the New session draft; PM, factory and automation starts keep their own rules. Defaults to
   * null so events written before it existed still parse.
   */
  defaultModel: z.string().nullable().default(null),
  /** The reasoning effort that goes with `defaultModel`; null: the model's default. */
  defaultEffort: ReasoningEffort.nullable().default(null),
  /** Overrides the global default per-session autonomy level (§11.2). */
  autonomy: AutonomyLevel.nullable(),
  /** Project autonomy mode (§10.1). */
  autonomyMode: AutonomyMode.default("assisted"),
  /** Vision file, relative to the repo root; required for the software and dark factory. */
  visionPath: z.string().min(1).default(DEFAULT_VISION_PATH),
  factoryLimits: FactoryLimits.prefault({}),
  /** Stops this project's factory loop and all its sessions. */
  killSwitch: z.boolean().default(false),
  /** IANA timezone for cron automations; machine timezone when null. */
  timezone: z.string().nullable(),
  /**
   * Agent sessions in this project run with `CI=true` (§4.2), so no command waits on a prompt
   * nothing can answer. Tools that read `CI` then behave as in CI (frozen lockfiles, Playwright
   * not reusing a running dev server, builds failing on warnings), so a project can turn it off:
   * the runner then adds no `CI` to its agents' environment. Defaults to true so events written
   * before the setting existed still parse.
   */
  agentCiEnv: z.boolean().default(true),
  /**
   * Where the project's new agent sessions run (`docs/remote-runners.md` §5): `local` worktrees
   * (the default) or, experimentally, a Docker container per session. Only GitHub projects can
   * use `docker`. Defaults to `local` so events written before the setting existed still parse.
   */
  execution: ProjectExecution.prefault({}),
  /**
   * Pinned projects are listed above the rest (§13). Defaults to false so events written
   * before pinning existed still parse.
   */
  pinned: z.boolean().default(false),
  /**
   * Manual position in the project list, lowest first (§13). Only the relative order within
   * the pinned and unpinned groups matters; ties fall back to the name. Set by
   * `projects.reordered`; archived projects keep theirs.
   */
  sortOrder: z.int().nonnegative().default(0),
  /**
   * Set when re-detection found the folder's git remote out of step with the project (see
   * `ProjectRemoteWarning`); absent when all is well. Cleared by the next detection that finds
   * the GitHub remote again, or by disconnecting GitHub.
   */
  remoteWarning: ProjectRemoteWarning.optional(),
  /**
   * The project group this project belongs to (DESIGN.md "Project groups"), at most one: its
   * agent sessions get the group's skills, and its PM and agents share the group's memory.
   * Defaults to null so events written before groups existed still parse.
   */
  groupId: Id.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
};

/** GitHub repository coordinates for a `github` project. */
export const GitHubRepo = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  remoteUrl: z.string().min(1),
  defaultBranch: z.string().min(1),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/**
 * A project. `github` projects get the full issue/PR/evidence flow; `local` projects
 * (no GitHub remote) get sessions, worktrees, checkpoints, diffs and automations only (§9).
 * The kind is detected when the project is added and again later (on server start, after
 * agent turns in local projects, on demand): a folder that gains a GitHub `origin` becomes a
 * `github` project. Losing the remote never downgrades a project on its own.
 */
export const Project = z.discriminatedUnion("kind", [
  z.object({ ...projectBase, kind: z.literal("github"), github: GitHubRepo }),
  z.object({ ...projectBase, kind: z.literal("local") }),
]);
export type Project = z.infer<typeof Project>;
export type ProjectKind = Project["kind"];

type Orderable = Pick<Project, "id" | "name" | "pinned" | "sortOrder">;

/**
 * The canonical project order (§13): pinned first, then `sortOrder`, then name, then id.
 * The server lists projects in this order and the UI keeps it when applying live events.
 */
export function compareProjects(a: Orderable, b: Orderable): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy of `projects` in the canonical order. */
export function sortProjects<T extends Orderable>(projects: readonly T[]): T[] {
  return [...projects].sort(compareProjects);
}
