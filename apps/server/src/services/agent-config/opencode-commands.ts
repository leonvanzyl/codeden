import { type Dirent, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { oneLineDescription, type SlashCommand } from "@codeden/contracts";
import { filesUnder } from "./discovery";
import { dirsFromRootTo, frontMatter } from "./paths";
import { COMMAND_NAME, commandInfo } from "./slash-commands";

/**
 * OpenCode's skills and custom commands as its files say (§13): the `/` menu of an OpenCode
 * session before OpenCode lists them itself (the New session draft, or a session that hasn't
 * reported yet). Read-only: CodeDen has no skill switches for OpenCode.
 */

/** How deep OpenCode looks for a `SKILL.md` under a skills folder. */
const MAX_SKILL_DEPTH = 6;

/** Folder entries OpenCode skips when scanning for skills. */
const skipped = (name: string) => name.startsWith(".") || name === "node_modules";

type EntryKind = "file" | "dir" | "linked-dir" | undefined;

/**
 * A directory entry's type. Skill folders are often linked in, so a link to a folder is
 * `linked-dir`: it counts as a skill when it holds a `SKILL.md` and is never walked, so a link
 * to a large or private folder (or a link loop) isn't scanned.
 */
function kindOf(dir: string, entry: Dirent): EntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const stat = statSync(join(dir, entry.name));
    return stat.isFile() ? "file" : stat.isDirectory() ? "linked-dir" : undefined;
  } catch {
    return undefined;
  }
}

function skillEntry(file: string, id: string): SlashCommand[] {
  if (!COMMAND_NAME.test(id)) return [];
  const description = oneLineDescription(frontMatter(file).description ?? "");
  return [{ name: id, description, kind: "skill", provider: "opencode" }];
}

/**
 * The skills in one skills folder, as OpenCode scans it: each folder holding a `SKILL.md` (up
 * to 6 deep, not looking further inside it) and `*.md` files at the top. A skill is named by
 * its folder (or file), which is the id OpenCode loads it by. A linked folder counts only as a
 * skill itself (its own `SKILL.md`); nothing behind a link is walked. Only front matter is read.
 */
export function openCodeSkillsIn(root: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  const queue: { dir: string; depth: number; linked?: boolean }[] = [{ dir: root, depth: 0 }];
  for (const { dir, depth, linked } of queue) {
    let entries: { name: string; kind: EntryKind }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !skipped(e.name))
        .map((e) => ({ name: e.name, kind: kindOf(dir, e) }));
    } catch {
      continue;
    }
    if (entries.some((e) => e.kind === "file" && e.name === "SKILL.md")) {
      out.push(...skillEntry(join(dir, "SKILL.md"), basename(dir)));
      continue;
    }
    if (linked) continue;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (depth === 0 && e.kind === "file" && e.name.endsWith(".md")) {
        out.push(...skillEntry(join(dir, e.name), e.name.slice(0, -3)));
      } else if ((e.kind === "dir" || e.kind === "linked-dir") && depth < MAX_SKILL_DEPTH) {
        queue.push({ dir: join(dir, e.name), depth: depth + 1, linked: e.kind === "linked-dir" });
      }
    }
  }
  return out;
}

/**
 * The commands in one OpenCode config folder (`.opencode`, `~/.config/opencode`):
 * `commands/**\/*.md`, then the legacy `command/**\/*.md` (OpenCode lets `commands/` win),
 * named by their path without `.md`, so `commands/team/review.md` is `team/review`.
 */
export function openCodeCommandsIn(configDir: string): SlashCommand[] {
  return ["commands", "command"].flatMap((folder) => {
    const dir = join(configDir, folder);
    return filesUnder(dir).flatMap((file) => {
      const name = relative(dir, file).replace(/\.md$/i, "").split(sep).join("/");
      if (!COMMAND_NAME.test(name)) return [];
      return [{ name, kind: "command" as const, provider: "opencode", ...commandInfo(file) }];
    });
  });
}

/**
 * OpenCode's commands and skills for a working folder, the first of a name winning, as OpenCode
 * resolves them: commands before skills (a typed `/<name>` runs the command); `.opencode`
 * before `.agents` before `.claude`; within each, the folders from `cwd` up to the repository
 * root (nearest first) before the user's own (`~/.config/opencode`, `~/.agents`, `~/.claude`).
 * OpenCode also reads skills and commands from its config and plugins; the session's own list
 * (`session.updated.commands`) brings those in once it runs.
 */
export function loadedOpenCodeCommands(
  home: string,
  cwd: string,
  gitRoot: string | null,
): SlashCommand[] {
  const upToRepo = gitRoot ? dirsFromRootTo(gitRoot, cwd).reverse() : [cwd];
  const userConfig = join(home, ".config", "opencode");
  const configDirs = [...upToRepo.map((d) => join(d, ".opencode")), userConfig];
  const skillDirs = [".opencode", ".agents", ".claude"].flatMap((name) => [
    ...upToRepo.map((d) => join(d, name, "skills")),
    name === ".opencode" ? join(userConfig, "skills") : join(home, name, "skills"),
  ]);
  // Each folder once: a working folder in the home folder reaches `~/.claude` both ways.
  return [
    ...[...new Set(configDirs)].flatMap(openCodeCommandsIn),
    ...[...new Set(skillDirs)].flatMap(openCodeSkillsIn),
  ];
}
