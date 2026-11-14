import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type CreateProjectRequest,
  type CreateProjectResponse,
  DEFAULT_VISION_PATH,
  type DisconnectGithubResponse,
  FactoryLimits,
  isFactoryMode,
  type Project,
  type ProjectDetection,
  type RefreshProjectResponse,
  sortProjects,
  type UpdateProjectRequest,
} from "@codeden/contracts";
import { eq, max } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToProject } from "../../db/rows";
import { projects } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, notFound, ServiceError } from "../errors";
import type { Exec } from "../exec";
import { detectProject, isDirectory, normalizeCloneUrl, redactUrls, sameRealPath } from "./detect";
import { type Reconciled, reconcileProject } from "./reconcile";

export { redactUrls };

export interface ProjectServiceDeps {
  db: Db;
  store: EventStore;
  exec: Exec;
  /** Where clones go when the user doesn't pick a folder (`~/codeden-projects`). */
  projectsDir: string;
}

const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Turn a name into a filesystem-safe slug (`[a-z0-9-]`, max 40 chars). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "project";
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

type DefaultAgent = Pick<Project, "defaultProvider" | "defaultModel" | "defaultEffort">;

/**
 * A project's default provider, model and effort after an update. A model id belongs to its
 * provider, so a new default provider without a model in the same update clears the model and
 * effort; a model or effort without a default provider is refused.
 */
export function defaultAgent(current: DefaultAgent, patch: UpdateProjectRequest): DefaultAgent {
  const provider =
    patch.defaultProvider !== undefined ? patch.defaultProvider : current.defaultProvider;
  const keep = provider === current.defaultProvider;
  const model =
    patch.defaultModel !== undefined ? patch.defaultModel : keep ? current.defaultModel : null;
  const effort =
    patch.defaultEffort !== undefined ? patch.defaultEffort : keep ? current.defaultEffort : null;
  if (provider === null && (model !== null || effort !== null)) {
    throw badRequest(
      "A default model or effort needs a default provider",
      "default_provider_required",
    );
  }
  return { defaultProvider: provider, defaultModel: model, defaultEffort: effort };
}

/** Projects: add from a local folder or a git clone, update, archive (§9, §14 step 5). */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /** Projects in the canonical order (§13): pinned first, then manual order, then name. */
  list(opts: { includeArchived?: boolean } = {}): Project[] {
    const all = this.deps.db.select().from(projects).all().map(rowToProject);
    return sortProjects(all.filter((p) => opts.includeArchived || p.archivedAt === null));
  }

  get(id: string): Project {
    const row = this.deps.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound(`No project ${id}`, "project_not_found");
    return rowToProject(row);
  }

  async create(req: CreateProjectRequest): Promise<CreateProjectResponse> {
    const folder =
      req.source.type === "local" ? resolve(req.source.path) : await this.clone(req.source);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(folder);
    } catch {
      throw badRequest(`Folder not found: ${folder}`, "folder_not_found");
    }
    if (!stat.isDirectory()) throw badRequest(`Not a folder: ${folder}`, "not_a_folder");

    const detected = await detectProject(this.deps.exec, folder);
    const path = detected.gitRoot ?? folder;
    const existing = this.list({ includeArchived: true }).find((p) => samePath(p.path, path));
    if (existing && existing.archivedAt === null) {
      throw conflict(`${existing.name} is already a project`, "project_exists");
    }
    const now = new Date().toISOString();
    if (existing) {
      // Restored: take what the folder looks like today (it may have gained a GitHub remote).
      const restored = { ...existing, archivedAt: null, updatedAt: now };
      const { project } = this.reconcile(restored, detected, now);
      this.deps.store.append([{ type: "project.updated", sessionId: null, payload: { project } }]);
      return { project, detected };
    }
    const project = this.build(req, path, detected, now);
    this.deps.store.append([{ type: "project.created", sessionId: null, payload: { project } }]);
    return { project, detected };
  }

  update(id: string, patch: UpdateProjectRequest): Project {
    const current = this.get(id);
    const next = { ...current, updatedAt: new Date().toISOString() } as Project;
    if (patch.name !== undefined) next.name = patch.name;
    Object.assign(next, defaultAgent(current, patch));
    if (patch.autonomy !== undefined) next.autonomy = patch.autonomy;
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.defaultBranch !== undefined) next.defaultBranch = patch.defaultBranch;
    // Pinning keeps `sortOrder`, so a project lands in its group by its manual position.
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    // Applies to agent sessions opened from now on; running ones keep the environment they have.
    if (patch.agentCiEnv !== undefined) next.agentCiEnv = patch.agentCiEnv;
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
    return next;
  }

  /**
   * Set the manual order of the project list (§13). `projectIds` must name every non-archived
   * project exactly once. Pinned projects still list first; within each group the order given
   * here applies.
   */
  reorder(projectIds: string[]): Project[] {
    const active = this.list();
    const known = new Set(active.map((p) => p.id));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of projectIds) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    const unknown = [...seen].filter((id) => !known.has(id));
    const missing = active.filter((p) => !seen.has(p.id)).map((p) => p.id);
    if (duplicates.size > 0 || unknown.length > 0 || missing.length > 0) {
      const problems = [
        duplicates.size > 0 && `listed more than once: ${[...duplicates].join(", ")}`,
        unknown.length > 0 && `not active projects: ${unknown.join(", ")}`,
        missing.length > 0 && `missing: ${missing.join(", ")}`,
      ].filter(Boolean);
      throw badRequest(
        `The order must list every active project exactly once (${problems.join("; ")})`,
        "invalid_order",
      );
    }
    this.deps.store.append([
      { type: "projects.reordered", sessionId: null, payload: { projectIds } },
    ]);
    return this.list();
  }

  archive(id: string): void {
    this.get(id);
    this.deps.store.append([
      { type: "project.archived", sessionId: null, payload: { projectId: id } },
    ]);
  }

  /**
   * Detect the folder's git checkout and GitHub remote again and apply what changed (§9, see
   * `reconcileProject`): a folder that gained a GitHub `origin` becomes a `github` project; one
   * that lost it keeps its coordinates and gets a `remoteWarning`. Appends `project.updated`
   * only when something changed.
   */
  async refresh(id: string): Promise<RefreshProjectResponse> {
    const before = this.get(id);
    if (!isDirectory(before.path)) {
      return {
        project: before,
        outcome: "folder_missing",
        changed: false,
        message: `The project folder is missing: ${before.path}`,
        detected: null,
      };
    }
    const detected = await detectProject(this.deps.exec, before.path);
    // Re-read: another change (a rename, a pin) may have landed while git ran.
    const result = this.reconcile(this.get(id), detected, new Date().toISOString());
    if (result.changed) {
      this.deps.store.append([
        { type: "project.updated", sessionId: null, payload: { project: result.project } },
      ]);
    }
    return { ...result, detected };
  }

  /**
   * Make a GitHub project local-only: the user's answer to a missing GitHub remote. Refused
   * while `origin` still points to GitHub (the next check would connect it again) and in a
   * factory mode (which needs GitHub). Synced issues and PRs stay in the database.
   */
  async disconnectGithub(id: string): Promise<DisconnectGithubResponse> {
    const project = this.get(id);
    if (project.kind !== "github") {
      throw conflict(`${project.name} is not connected to GitHub`, "not_a_github_project");
    }
    if (isFactoryMode(project.autonomyMode)) {
      throw conflict(
        "Switch the autonomy mode to assisted or manual before disconnecting GitHub",
        "factory_mode",
      );
    }
    const detected = isDirectory(project.path)
      ? await detectProject(this.deps.exec, project.path)
      : null;
    if (detected?.github) {
      const { owner, repo } = detected.github;
      throw conflict(
        `origin still points to ${owner}/${repo} on GitHub; change or remove it first`,
        "github_remote_present",
      );
    }
    const current = this.get(id);
    if (current.kind !== "github") return { project: current };
    const { github: _github, remoteWarning: _warning, ...rest } = current;
    const next: Project = { ...rest, kind: "local", updatedAt: new Date().toISOString() };
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
    return { project: next };
  }

  private reconcile(project: Project, detected: ProjectDetection, now: string): Reconciled {
    return reconcileProject(project, detected, {
      now,
      gitDirPresent: existsSync(join(project.path, ".git")),
      ownCheckout: !detected.gitRoot || sameRealPath(detected.gitRoot, project.path),
    });
  }

  private build(
    req: CreateProjectRequest,
    path: string,
    detected: ProjectDetection,
    now: string,
  ): Project {
    const name = req.name ?? basename(path);
    const base = {
      id: randomUUID(),
      name,
      slug: this.uniqueSlug(slugify(name)),
      path,
      defaultBranch: detected.defaultBranch,
      defaultProvider: req.defaultProvider ?? null,
      defaultModel: null,
      defaultEffort: null,
      autonomy: req.autonomy ?? null,
      autonomyMode: "assisted" as const,
      visionPath: DEFAULT_VISION_PATH,
      factoryLimits: FactoryLimits.parse({}),
      killSwitch: false,
      timezone: null,
      agentCiEnv: true,
      pinned: false,
      sortOrder: this.nextSortOrder(),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    return detected.github
      ? { ...base, kind: "github", github: detected.github }
      : { ...base, kind: "local" };
  }

  /** New projects go to the end of the unpinned group, after every slot (archived included). */
  private nextSortOrder(): number {
    const row = this.deps.db
      .select({ last: max(projects.sortOrder) })
      .from(projects)
      .get();
    return typeof row?.last === "number" ? row.last + 1 : 0;
  }

  private uniqueSlug(base: string): string {
    const taken = new Set(this.list({ includeArchived: true }).map((p) => p.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async clone(source: Extract<CreateProjectRequest["source"], { type: "clone" }>) {
    const { url, name } = normalizeCloneUrl(source.url);
    const dest = resolve(source.path ?? join(source.parentDir ?? this.deps.projectsDir, name));
    if (existsSync(dest) && readdirSync(dest).length > 0) {
      throw conflict(`${dest} already exists and is not empty`, "destination_exists");
    }
    mkdirSync(dirname(dest), { recursive: true });
    const result = await this.deps.exec("git", ["clone", "--", url, dest], {
      timeoutMs: CLONE_TIMEOUT_MS,
      cwd: dirname(dest),
    });
    if (result.notFound) throw new ServiceError(503, "git_missing", "git is not installed");
    if (result.code !== 0) {
      const detail = redactUrls(result.stderr.trim().split("\n").slice(-3).join("\n"));
      throw new ServiceError(502, "clone_failed", detail || "git clone failed");
    }
    return dest;
  }
}
