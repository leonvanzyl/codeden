import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentConfigDiff,
  type AgentConfigProvider,
  type AgentConfigScope,
  agentConfigFeatures,
  type HookChangeRequest,
  type HookEntry,
  type HookListResponse,
  type HookWriteResponse,
  providersWith,
  type ShelvedHook,
} from "@codeden/contracts";
import { badRequest, errorMessage, forbidden } from "../errors";
import { resolveInside } from "../files/path-guard";
import { atomicWrite, unifiedDiff } from "./files";
import type { HookShelf } from "./hook-shelf";
import {
  addHook,
  claudeHookFile,
  type HookFile,
  readHookFile,
  removeHook,
  renderHookChange,
  unusableSource,
  updateHook,
} from "./hooks";

type Native = Record<string, unknown>;

export interface AgentConfigHooksDeps {
  home: string;
  project: (id: string) => { id: string; path: string };
  /** Copy a file to the agent-config backups folder; returns the copy's path. */
  backup: (file: string) => string;
  shelf: HookShelf;
}

/** What a change does: the settings file it rewrites (if any) and the shelf steps around it. */
interface Plan {
  file: HookFile | null;
  mutate: (hooks: Native) => void;
  /** Runs before the file is written (and is undone with `rollback` if the write fails). */
  beforeWrite?: () => void;
  rollback?: () => void;
  /** Runs after the file is written, or on its own when no file changes. */
  afterWrite?: () => void;
}

/**
 * Hooks in each provider's settings files (§12.4), for providers with
 * `agentConfigFeatures[p].hooks`. Only the `hooks` key is rewritten; every write is previewed
 * by `diff`, backed up first and atomic. Disabled hooks live on the `HookShelf`.
 */
export class AgentConfigHooks {
  constructor(private readonly deps: AgentConfigHooksDeps) {}

  /** User hooks, plus the project's when `projectId` is given, and the disabled ones. */
  list(projectId?: string): HookListResponse {
    const project = projectId ? this.deps.project(projectId) : null;
    const scopes: AgentConfigScope[] = project ? ["user", "project", "local"] : ["user"];
    const read = providersWith("hooks").flatMap((provider) =>
      scopes.map((scope) => {
        const file = this.fileFor(provider, scope, project);
        try {
          guard(file);
        } catch (error) {
          return { source: unusableSource(file, errorMessage(error)), hooks: [] };
        }
        return readHookFile(file);
      }),
    );
    const shelved = this.deps.shelf
      .list()
      .filter((s) => agentConfigFeatures[s.provider].hooks)
      .filter((s) => (s.scope === "user" ? true : s.projectId === project?.id))
      .map(shelvedEntry);
    return {
      sources: read.map((r) => r.source),
      hooks: [...read.flatMap((r) => r.hooks), ...shelved],
    };
  }

  /** The diff a change would make to its settings file (unchanged for shelf-only removals). */
  diff(req: HookChangeRequest): AgentConfigDiff {
    const plan = this.plan(req);
    if (!plan.file) return unifiedDiff(this.deps.shelf.file, true, "", "");
    const { before, after, existed } = renderHookChange(plan.file.file, plan.mutate);
    return unifiedDiff(plan.file.file, existed, before, after);
  }

  /**
   * Apply a change; the response carries the list for `req.listProjectId` afterwards. `plan`
   * has already resolved that project, so listing can't fail after the write for that reason.
   */
  apply(req: HookChangeRequest): HookWriteResponse {
    const written = this.write(req);
    return { ...written, hooks: this.list(req.listProjectId) };
  }

  private write(req: HookChangeRequest): Pick<HookWriteResponse, "file" | "backupPath"> {
    const plan = this.plan(req);
    if (!plan.file) {
      plan.afterWrite?.();
      return { file: null, backupPath: null };
    }
    const file = plan.file.file;
    const { after, existed, changed } = renderHookChange(file, plan.mutate);
    if (!changed) return { file, backupPath: null };
    plan.beforeWrite?.();
    let backupPath: string | null;
    try {
      backupPath = existed ? this.deps.backup(file) : null;
      // Check again once the folder exists, right before writing, so a link created since
      // the plan can't redirect the write.
      mkdirSync(dirname(file), { recursive: true });
      guard(plan.file);
      atomicWrite(file, after);
    } catch (error) {
      plan.rollback?.();
      throw error;
    }
    plan.afterWrite?.();
    return { file, backupPath };
  }

  /**
   * What a change will do, with every input checked first: the project of the list to return
   * (`listProjectId`, 404 if unknown) is resolved here, before anything is read or written, so a
   * request that fails never changes a settings file, the shelf or the backups.
   */
  private plan(req: HookChangeRequest): Plan {
    if (req.listProjectId) this.deps.project(req.listProjectId);
    const shelf = this.deps.shelf;
    switch (req.action) {
      case "add": {
        const file = this.target(req.provider, req.scope, req.projectId);
        return {
          file,
          mutate: (h) => addHook(h, file.file, req.event, req.matcher, req.handler),
        };
      }
      case "update": {
        const t = req.target;
        const file = this.target(t.provider, t.scope, t.projectId);
        return { file, mutate: (h) => updateHook(h, file.file, t, req) };
      }
      case "remove": {
        const t = req.target;
        if ("shelfId" in t) {
          shelf.get(t.shelfId);
          return { file: null, mutate: () => {}, afterWrite: () => shelf.remove(t.shelfId) };
        }
        const file = this.target(t.provider, t.scope, t.projectId);
        return { file, mutate: (h) => void removeHook(h, file.file, t) };
      }
      case "disable": {
        const t = req.target;
        const file = this.target(t.provider, t.scope, t.projectId);
        let matcher: string | null = null;
        let shelved: ShelvedHook | undefined;
        return {
          file,
          // `removeHook` checks the handler still equals `expected`, so that is what is shelved.
          mutate: (h) => {
            matcher = removeHook(h, file.file, t).matcher;
          },
          beforeWrite: () => {
            shelved = shelf.add({
              provider: file.provider,
              scope: file.scope,
              projectId: file.projectId,
              file: file.file,
              event: t.event,
              matcher,
              handler: t.expected,
            });
          },
          rollback: () => shelved && shelf.remove(shelved.id),
        };
      }
      case "enable": {
        const entry = shelf.get(req.target.shelfId);
        const file = this.target(entry.provider, entry.scope, entry.projectId ?? undefined);
        return {
          file,
          mutate: (h) => addHook(h, file.file, entry.event, entry.matcher, entry.handler),
          afterWrite: () => shelf.remove(entry.id),
        };
      }
    }
  }

  /**
   * The settings file a request addresses, after checking the provider has hooks and that the
   * file stays inside its scope's folder (so a linked `.claude` can't redirect the edit).
   */
  private target(provider: AgentConfigProvider, scope: AgentConfigScope, projectId?: string) {
    if (!agentConfigFeatures[provider].hooks) {
      throw badRequest(`CodeDen does not edit ${provider} hooks`, "hooks_unsupported");
    }
    if (scope !== "user" && !projectId) {
      throw badRequest("projectId is required for this scope", "project_required");
    }
    const file = this.fileFor(provider, scope, projectId ? this.deps.project(projectId) : null);
    guard(file);
    return file;
  }

  private fileFor(
    _provider: AgentConfigProvider,
    scope: AgentConfigScope,
    project: { id: string; path: string } | null,
  ): HookFile {
    // Only Claude Code has hooks today (`agentConfigFeatures`); its files are the only kind.
    return claudeHookFile(scope, this.deps.home, project);
  }
}

/**
 * Refuse (403 `path_outside_root`) a settings file whose real path, following links on the file
 * and on every existing ancestor, leaves its scope's folder.
 */
function guard(f: HookFile): void {
  try {
    resolveInside(f.root, f.file);
  } catch {
    throw forbidden(
      `${f.file} resolves outside ${f.root} through a link; CodeDen won't read or write it`,
      "path_outside_root",
    );
  }
}

function shelvedEntry(s: ShelvedHook): HookEntry {
  return {
    provider: s.provider,
    scope: s.scope,
    projectId: s.projectId,
    file: s.file,
    event: s.event,
    matcher: s.matcher,
    handler: s.handler,
    enabled: false,
    shelfId: s.id,
  };
}
