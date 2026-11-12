import type {
  AgentConfigDiff,
  AgentConfigScope,
  HookChangeRequest,
  HookEntry,
  HookHandler,
  HookListResponse,
  HookSource,
  HookTarget,
  ShelvedHook,
} from "@codeden/contracts";
import type { AgentConfigApi } from "../feature-apis";

/**
 * In-memory hooks for the mock client (`VITE_CODEDEN_MOCK=1`): one settings object per scope
 * and project, edited the way the server does it (only the `hooks` key, groups by matcher).
 */

type Group = { matcher?: string; hooks: HookHandler[] };
type Hooks = Record<string, Group[]>;
interface MockFile {
  scope: AgentConfigScope;
  projectId: string | null;
  file: string;
  hooks: Hooks;
}

const HOME = "C:\\Users\\you";
const fileFor = (scope: AgentConfigScope, projectId: string | null) =>
  scope === "user"
    ? `${HOME}\\.claude\\settings.json`
    : `C:\\Code\\${projectId}\\.claude\\settings${scope === "local" ? ".local" : ""}.json`;

function seed(): Map<string, MockFile> {
  const files = new Map<string, MockFile>();
  const add = (scope: AgentConfigScope, projectId: string | null, hooks: Hooks) =>
    files.set(`${scope}:${projectId ?? ""}`, {
      scope,
      projectId,
      file: fileFor(scope, projectId),
      hooks,
    });
  add("user", null, {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "~/.claude/hooks/block-rm-rf.sh", timeout: 10 }],
      },
    ],
    Notification: [{ hooks: [{ type: "command", command: "notify-send 'Claude needs you'" }] }],
  });
  add("project", "p-storefront", {
    PostToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [
          { type: "command", command: "pnpm biome format --write", statusMessage: "Formatting" },
        ],
      },
    ],
    Stop: [{ hooks: [{ type: "prompt", prompt: "Did the agent run the tests?", timeout: 30 }] }],
  });
  return files;
}

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));
/** Matchers are kept exactly as written; only missing or empty means "match everything". */
const norm = (m: string | null | undefined) => (m ? m : null);

export function mockHooksApi(
  diff: (path: string, before: string, after: string) => AgentConfigDiff,
): Pick<AgentConfigApi, "listHooks" | "diffHook" | "changeHook"> {
  const files = seed();
  let shelf: ShelvedHook[] = [];
  const fileOf = (scope: AgentConfigScope, projectId?: string | null): MockFile => {
    const id = scope === "user" ? null : (projectId ?? null);
    const key = `${scope}:${id ?? ""}`;
    const found = files.get(key) ?? { scope, projectId: id, file: fileFor(scope, id), hooks: {} };
    files.set(key, found);
    return found;
  };
  const addTo = (hooks: Hooks, event: string, matcher: string | null, handler: HookHandler) => {
    const groups = hooks[event] ?? [];
    hooks[event] = groups;
    const group = groups.find((g) => norm(g.matcher) === matcher);
    if (group) group.hooks.push(handler);
    else groups.push(matcher ? { matcher, hooks: [handler] } : { hooks: [handler] });
  };
  const removeAt = (hooks: Hooks, t: HookTarget) => {
    const groups = hooks[t.event] ?? [];
    const group = groups[t.groupIndex];
    if (!group?.hooks[t.handlerIndex]) throw new Error("That hook is no longer in the file");
    group.hooks.splice(t.handlerIndex, 1);
    if (!group.hooks.length) groups.splice(t.groupIndex, 1);
    if (!groups.length) delete hooks[t.event];
    return norm(group.matcher);
  };

  /** The next `hooks` for the file a change touches (null: only the shelf changes). */
  const plan = (req: HookChangeRequest) => {
    if (req.action === "add") {
      const file = fileOf(req.scope, req.projectId);
      const next = structuredClone(file.hooks);
      addTo(next, req.event, norm(req.matcher), req.handler);
      return { file, next, commit: () => {} };
    }
    if (req.action === "enable" || (req.action === "remove" && "shelfId" in req.target)) {
      const id = "shelfId" in req.target ? req.target.shelfId : "";
      const entry = shelf.find((s) => s.id === id);
      if (!entry) throw new Error("That disabled hook is no longer on the shelf");
      const drop = () => {
        shelf = shelf.filter((s) => s.id !== id);
      };
      if (req.action === "remove") return { file: null, next: null, commit: drop };
      const file = fileOf(entry.scope, entry.projectId);
      const next = structuredClone(file.hooks);
      addTo(next, entry.event, entry.matcher, entry.handler);
      return { file, next, commit: drop };
    }
    const t = req.target as HookTarget;
    const file = fileOf(t.scope, t.projectId);
    const next = structuredClone(file.hooks);
    const matcher = removeAt(next, t);
    if (req.action === "update") addTo(next, req.event, norm(req.matcher), req.handler);
    const commit =
      req.action === "disable"
        ? () => {
            shelf.push({
              id: `shelf-${Date.now()}`,
              provider: "claude",
              scope: file.scope,
              projectId: file.projectId,
              file: file.file,
              event: t.event,
              matcher,
              handler: t.expected,
              disabledAt: new Date().toISOString(),
            });
          }
        : () => {};
    return { file, next, commit };
  };
  const show = (hooks: Hooks) => JSON.stringify({ hooks }, null, 2);

  const list = (projectId: string | null | undefined): HookListResponse => {
    const scopes: AgentConfigScope[] = projectId ? ["user", "project", "local"] : ["user"];
    const sources: HookSource[] = [];
    const hooks: HookEntry[] = [];
    for (const scope of scopes) {
      const f = fileOf(scope, projectId);
      const base = { provider: "claude" as const, scope, projectId: f.projectId, file: f.file };
      sources.push({ ...base, exists: true, disableAllHooks: false });
      for (const [event, groups] of Object.entries(f.hooks)) {
        groups.forEach((g, groupIndex) => {
          g.hooks.forEach((handler, handlerIndex) => {
            hooks.push({
              ...base,
              event,
              matcher: norm(g.matcher),
              handler,
              enabled: true,
              groupIndex,
              handlerIndex,
            });
          });
        });
      }
    }
    for (const s of shelf) {
      if (s.scope !== "user" && s.projectId !== projectId) continue;
      const { id, disabledAt: _at, ...rest } = s;
      hooks.push({ ...rest, enabled: false, shelfId: id });
    }
    return { sources, hooks };
  };

  return {
    listHooks: (projectId) => delay(list(projectId)),
    diffHook: async (req) => {
      const p = plan(req);
      if (!p.file || !p.next) return delay(diff("disabled-hooks.json", "", ""));
      return delay(diff(p.file.file, show(p.file.hooks), show(p.next)), 100);
    },
    changeHook: async (req) => {
      const p = plan(req);
      if (p.file && p.next) p.file.hooks = p.next;
      p.commit();
      return delay({
        file: p.file?.file ?? null,
        backupPath: p.file ? "~/.codeden/backups/agent-config/settings.json" : null,
        hooks: list(req.listProjectId),
      });
    },
  };
}
