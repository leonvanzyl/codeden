import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  AgentConfigFile,
  AgentConfigKind,
  AgentConfigProvider,
  AgentConfigScope,
  AgentSkill,
} from "@codeden/contracts";
import { frontMatter, toRelative } from "./paths";

/** A skill as found on disk, before its provider's switch setting is read (`skills-service.ts`). */
export type DiscoveredSkill = Omit<AgentSkill, "enabled" | "visibility" | "setIn">;

/** A folder files are addressed relative to (`AgentConfigLocator.root`). */
export interface ConfigRoot {
  root: AgentConfigFile["root"];
  dir: string;
  projectId?: string;
}

interface Meta {
  provider: AgentConfigProvider;
  kind: AgentConfigKind;
  scope: AgentConfigScope;
  name?: string;
  description?: string;
  onDemand?: boolean;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage"]);
const MAX_SCAN_DIRS = 4_000;
const MAX_SCAN_DEPTH = 6;

/** Describe one file (existing or not) as an `AgentConfigFile`. */
export function fileEntry(root: ConfigRoot, absolutePath: string, meta: Meta): AgentConfigFile {
  let exists = false;
  let sizeBytes = 0;
  let modifiedAt: string | null = null;
  try {
    const stat = statSync(absolutePath);
    if (stat.isFile()) {
      exists = true;
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    }
  } catch {
    // missing
  }
  return {
    root: root.root,
    ...(root.projectId ? { projectId: root.projectId } : {}),
    path: toRelative(root.dir, absolutePath),
    provider: meta.provider,
    kind: meta.kind,
    scope: meta.scope,
    name: meta.name ?? basename(absolutePath),
    ...(meta.description ? { description: meta.description } : {}),
    absolutePath,
    exists,
    sizeBytes,
    modifiedAt,
    ...(meta.onDemand ? { onDemand: true } : {}),
  };
}

/** Existing entries only. */
export function existing(root: ConfigRoot, absolutePath: string, meta: Meta): AgentConfigFile[] {
  const entry = fileEntry(root, absolutePath, meta);
  return entry.exists ? [entry] : [];
}

/** Every `*.md` (or `ext`) file under `dir`, recursively, sorted. */
export function filesUnder(dir: string, ext = ".md"): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** Skills in a skills folder: `<dir>/<name>/SKILL.md`. */
export function skillsIn(
  root: ConfigRoot,
  dir: string,
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
): DiscoveredSkill[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) return [];
    const fm = frontMatter(file);
    const meta = { provider, kind: "skill" as const, scope, name: fm.name ?? name };
    const entry = fileEntry(root, file, { ...meta, description: fm.description });
    return [{ provider, scope, name: meta.name, description: fm.description, file: entry }];
  });
}

/** Claude subagents (`*.md` with front matter) or Codex agents (`*.toml`) in a folder. */
export function subagentsIn(
  root: ConfigRoot,
  dir: string,
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
): AgentConfigFile[] {
  const files = provider === "claude" ? filesUnder(dir, ".md") : filesUnder(dir, ".toml");
  return files.map((file) => {
    const info = provider === "claude" ? frontMatter(file) : tomlInfo(file);
    return fileEntry(root, file, {
      provider,
      kind: "subagent",
      scope,
      name: info.name ?? basename(file).replace(/\.(md|toml)$/i, ""),
      description: info.description,
    });
  });
}

function tomlInfo(file: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(file, "utf8").slice(0, 8_000);
    const pick = (key: string) =>
      new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(text)?.[1];
    return { name: pick("name"), description: pick("description") };
  } catch {
    return {};
  }
}

/**
 * Memory files in subfolders of a checkout (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
 * `AGENTS.override.md`), skipping dot folders and build output. Bounded in depth and size.
 */
export function nestedMemoryFiles(projectDir: string): string[] {
  const wanted = new Set(["claude.md", "claude.local.md", "agents.md", "agents.override.md"]);
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || visited++ > MAX_SCAN_DIRS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (depth > 0 && e.isFile() && wanted.has(e.name.toLowerCase())) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(projectDir, 0);
  return out.sort();
}
