import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AgentConfigProvider,
  type AgentConfigScope,
  type HookEntry,
  HookHandler,
  type HookSource,
  type HookTarget,
} from "@codeden/contracts";
import { conflict, notFound, ServiceError } from "../errors";
import { setTopLevelMember } from "./json-edit";
import { mainRepoRoot } from "./paths";

/**
 * Hooks in Claude Code's settings files (§12.4): read the `hooks` key, and render changes to it
 * as new file text that differs only inside that key. Writing, backups and the shelf for
 * disabled hooks live in `hooks-service.ts`.
 */

type Native = Record<string, unknown>;
type Group = Native & { hooks: unknown[] };

/** One settings file that holds hooks. */
export interface HookFile {
  provider: AgentConfigProvider;
  scope: AgentConfigScope;
  projectId: string | null;
  /** The folder the file must stay inside, links included: the home or the project checkout. */
  root: string;
  file: string;
}

const isRecord = (v: unknown): v is Native =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isGroup = (v: unknown): v is Group => isRecord(v) && Array.isArray(v.hooks);
/**
 * A group's matcher exactly as written (whitespace can matter in a regex); missing or empty
 * means "match everything".
 */
export const matcherOf = (m: unknown): string | null =>
  typeof m === "string" && m !== "" ? m : null;

const unparsable = (file: string, why: string) =>
  new ServiceError(422, "config_unparsable", `${file} could not be parsed: ${why}`);

/** Claude Code's settings file for a scope. */
export function claudeHookFile(
  scope: AgentConfigScope,
  home: string,
  project: { id: string; path: string } | null,
): HookFile {
  if (scope === "user" || !project) {
    return {
      provider: "claude",
      scope: "user",
      projectId: null,
      root: home,
      file: join(home, ".claude", "settings.json"),
    };
  }
  const name = scope === "local" ? "settings.local.json" : "settings.json";
  return {
    provider: "claude",
    scope,
    projectId: project.id,
    root: project.path,
    file: join(project.path, ".claude", name),
  };
}

/**
 * The Claude Code settings files that apply to a session in `cwd`, lowest precedence first
 * (What's loaded, §12.4):
 * - user: `~/.claude/settings.json`;
 * - project: `<cwd>/.claude/settings.json`, with no fallback to parent folders;
 * - local: `.claude/settings.local.json` at the repository root (the main checkout's root for a
 *   worktree), or beside the shared file on Windows, outside a git repository, or when the
 *   repository root is the home folder. With the root file, a local file an older Claude Code
 *   left in `cwd` is still read, so it is listed after the root one (which wins over it).
 * `platform` is a parameter so both placements can be tested on any OS.
 */
export function claudeSessionHookFiles(
  home: string,
  cwd: string,
  gitRoot: string | null,
  projectId: string | null,
  platform: NodeJS.Platform = process.platform,
): HookFile[] {
  const inFolder = (scope: AgentConfigScope, root: string, name: string): HookFile => ({
    provider: "claude",
    scope,
    projectId,
    root,
    file: join(root, ".claude", name),
  });
  const files = [claudeHookFile("user", home, null), inFolder("project", cwd, "settings.json")];
  const repoRoot = gitRoot ? mainRepoRoot(gitRoot) : null;
  const atRoot = repoRoot !== null && platform !== "win32" && resolve(repoRoot) !== resolve(home);
  if (!atRoot) return [...files, inFolder("local", cwd, "settings.local.json")];
  const local = inFolder("local", repoRoot, "settings.local.json");
  const legacy = inFolder("local", cwd, "settings.local.json");
  const keepLegacy = resolve(legacy.file) !== resolve(local.file) && existsSync(legacy.file);
  return [...files, local, ...(keepLegacy ? [legacy] : [])];
}

/** A source that can't be read or written, with why (unparsable, or outside its folder). */
export function unusableSource(f: HookFile, error: string): HookSource {
  return {
    provider: f.provider,
    scope: f.scope,
    projectId: f.projectId,
    file: f.file,
    exists: existsSync(f.file),
    disableAllHooks: false,
    error,
  };
}

interface Loaded {
  text: string | null;
  doc: Native;
}

function load(file: string): Loaded {
  if (!existsSync(file)) return { text: null, doc: {} };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { text, doc: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw unparsable(file, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(doc)) throw unparsable(file, "not a JSON object");
  if (doc.hooks !== undefined && !isRecord(doc.hooks))
    throw unparsable(file, "`hooks` is not an object");
  return { text, doc };
}

/** A settings file read for hooks. */
export interface ReadHooks {
  source: HookSource;
  hooks: HookEntry[];
  /** The `disableAllHooks` value the file sets (true or false); absent when it doesn't set one. */
  disableAllHooks?: boolean;
}

/** The file as a source, and the hooks it defines (malformed entries are skipped). */
export function readHookFile(f: HookFile): ReadHooks {
  const base = { provider: f.provider, scope: f.scope, projectId: f.projectId, file: f.file };
  let loaded: Loaded;
  try {
    loaded = load(f.file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: unusableSource(f, message), hooks: [] };
  }
  const { text, doc } = loaded;
  const source = { ...base, exists: text !== null, disableAllHooks: doc.disableAllHooks === true };
  const disableAllHooks =
    typeof doc.disableAllHooks === "boolean" ? { disableAllHooks: doc.disableAllHooks } : {};
  const hooks: HookEntry[] = [];
  for (const [event, groups] of Object.entries(isRecord(doc.hooks) ? doc.hooks : {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isGroup(group)) return;
      const matcher = matcherOf(group.matcher);
      group.hooks.forEach((raw, handlerIndex) => {
        const handler = HookHandler.safeParse(raw);
        if (!handler.success) return;
        hooks.push({
          ...base,
          event,
          matcher,
          handler: handler.data,
          enabled: true,
          groupIndex,
          handlerIndex,
        });
      });
    });
  }
  return { source, hooks, ...disableAllHooks };
}

/** The file text before and after applying `mutate` to its `hooks` object. */
export function renderHookChange(file: string, mutate: (hooks: Native) => void) {
  const { text, doc } = load(file);
  const current = isRecord(doc.hooks) ? doc.hooks : {};
  const hooks = structuredClone(current);
  mutate(hooks);
  const before = text ?? "";
  const existed = text !== null;
  if (isDeepStrictEqual(hooks, current)) return { before, after: before, existed, changed: false };
  const after = text?.trim()
    ? setTopLevelMember(text, "hooks", hooks)
    : `${JSON.stringify({ hooks }, null, 2)}\n`;
  return { before, after, existed, changed: true };
}

/** The groups of one event, created when missing. */
function groupsOf(hooks: Native, event: string, file: string): unknown[] {
  const existing = hooks[event];
  if (existing === undefined) {
    hooks[event] = [];
    return hooks[event] as unknown[];
  }
  if (!Array.isArray(existing)) throw unparsable(file, `\`hooks.${event}\` is not a list`);
  return existing;
}

/** Append a handler to the first group of `event` with the same matcher, or to a new group. */
export function addHook(
  hooks: Native,
  file: string,
  event: string,
  matcher: string | null | undefined,
  handler: Native,
): void {
  const m = matcherOf(matcher);
  const groups = groupsOf(hooks, event, file);
  const group = groups.find((g): g is Group => isGroup(g) && matcherOf(g.matcher) === m);
  if (group) group.hooks.push(handler);
  else groups.push(m === null ? { hooks: [handler] } : { matcher: m, hooks: [handler] });
}

type Position = Pick<HookTarget, "event" | "groupIndex" | "handlerIndex" | "expected">;

/** The handler at a position, checked against what the caller listed. */
function locate(hooks: Native, file: string, t: Position) {
  const groups = hooks[t.event];
  const group = Array.isArray(groups) ? groups[t.groupIndex] : undefined;
  const current = isGroup(group) ? group.hooks[t.handlerIndex] : undefined;
  if (!Array.isArray(groups) || !isGroup(group) || !isRecord(current)) {
    throw notFound(`No such ${t.event} hook in ${file}; reload the list`, "hook_not_found");
  }
  if (!isDeepStrictEqual(current, t.expected)) {
    throw conflict(
      `The hook changed in ${file} since it was listed; reload the list`,
      "hook_changed",
    );
  }
  return { groups, group, current };
}

/** Remove the handler at a position; groups and events left empty go too. */
export function removeHook(hooks: Native, file: string, t: Position) {
  const { groups, group } = locate(hooks, file, t);
  group.hooks.splice(t.handlerIndex, 1);
  if (group.hooks.length === 0) groups.splice(t.groupIndex, 1);
  if (groups.length === 0) delete hooks[t.event];
  return { matcher: matcherOf(group.matcher) };
}

/** Replace the handler in place, or move it when the event or matcher changes. */
export function updateHook(
  hooks: Native,
  file: string,
  t: Position,
  next: { event: string; matcher?: string; handler: Native },
): void {
  const { group } = locate(hooks, file, t);
  if (next.event === t.event && matcherOf(next.matcher) === matcherOf(group.matcher)) {
    group.hooks[t.handlerIndex] = next.handler;
    return;
  }
  removeHook(hooks, file, t);
  addHook(hooks, file, next.event, next.matcher, next.handler);
}
