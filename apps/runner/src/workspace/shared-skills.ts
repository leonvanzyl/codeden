import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GroupSkillName, type SharedSkillFile } from "@codeden/contracts";
import { gitText } from "../git/exec";

/**
 * Marks a skill folder the runner wrote. It holds the hash of the `SKILL.md` written with it, so
 * a folder whose `SKILL.md` was replaced since (by git bringing in the project's own skill of
 * that name, or by hand) is no longer the runner's.
 */
export const SHARED_SKILL_MARKER = ".codeden-shared-skill";
const SKILL_FILE = "SKILL.md";
const OWN_FILES = new Set([SKILL_FILE, ".gitignore", SHARED_SKILL_MARKER]);

/** What a sync did, per skill folder name, and the skill folders it could not use (the log). */
export interface SharedSkillsSync {
  written: string[];
  /** The workspace has a skill of that name of its own: the project's wins. */
  skipped: string[];
  removed: string[];
  /** Skill folders that lead outside the workspace or are links: left alone, nothing written. */
  blocked: string[];
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const lstat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const isFile = (path: string) => lstat(path)?.isFile() ?? false;

/** `path`, or its nearest existing ancestor, resolves inside `cwd` (no link leads out). */
function insideWorkspace(cwd: string, path: string): boolean {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const rel = relative(realpathSync(cwd), realpathSync(existing));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A folder this runner wrote and that is still as it left it: a real directory with only its
 * three files, none of them tracked by git, and a `SKILL.md` matching the marker's hash.
 */
function ours(folder: string, tracked: (folder: string) => boolean): boolean {
  if (!lstat(folder)?.isDirectory() || tracked(folder)) return false;
  const marker = join(folder, SHARED_SKILL_MARKER);
  const skill = join(folder, SKILL_FILE);
  if (!isFile(marker) || !isFile(skill)) return false;
  if (!readdirSync(folder).every((name) => OWN_FILES.has(name))) return false;
  return readFileSync(marker, "utf8").trim() === hash(readFileSync(skill, "utf8"));
}

/** Folders under `root` that hold a file git tracks (a project's committed skills). */
async function trackedFolders(cwd: string, root: string): Promise<(folder: string) => boolean> {
  let listed: string[] = [];
  try {
    const out = await gitText(cwd, ["ls-files", "--full-name", "-z", "--", root]);
    const top = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
    listed = out
      .split("\0")
      .filter(Boolean)
      .map((p) => join(top.trim(), p));
  } catch {
    // Not a git checkout: nothing is tracked.
  }
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const files = listed.map(real);
  return (folder) => {
    const prefix = `${real(folder)}/`;
    return files.some((f) => f.replaceAll("\\", "/").startsWith(prefix.replaceAll("\\", "/")));
  };
}

/** Write a file, replacing a link or anything else at the path instead of writing through it. */
function writeOwn(path: string, text: string): void {
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, text, "utf8");
}

/**
 * Bring a workspace's shared skills (a project group's, `SessionOptions.sharedSkills`) in line
 * with `skills`, in each of the provider's skill folders (`capabilities.skillDirs`, relative to
 * `cwd`). Each skill is a native `<dir>/<name>/SKILL.md`, as a project's own skills are, plus a
 * `.gitignore` of `*` so git, checkpoints and diffs never see it, and the marker.
 *
 * A folder of that name that isn't the runner's (see `ours`) is the project's own skill and
 * wins: it is left alone. The runner's folders for skills no longer listed are removed, so a
 * project that left its group loses them on the next open. A skill folder that leads outside the
 * workspace is not touched at all. Nothing else is ever written or removed.
 */
export async function syncSharedSkills(
  cwd: string,
  dirs: readonly string[],
  skills: readonly SharedSkillFile[],
): Promise<SharedSkillsSync> {
  const result: SharedSkillsSync = { written: [], skipped: [], removed: [], blocked: [] };
  const wanted = new Map(
    skills.filter((s) => GroupSkillName.safeParse(s.name).success).map((s) => [s.name, s]),
  );
  for (const dir of dirs) {
    const root = join(cwd, dir);
    const rootStat = lstat(root);
    if ((rootStat && !rootStat.isDirectory()) || !insideWorkspace(cwd, root)) {
      if (rootStat || wanted.size > 0) result.blocked.push(dir);
      continue;
    }
    const tracked = await trackedFolders(cwd, root);
    if (rootStat) {
      for (const name of readdirSync(root)) {
        const folder = join(root, name);
        if (!wanted.has(name) && ours(folder, tracked)) {
          rmSync(folder, { recursive: true, force: true });
          result.removed.push(name);
        }
      }
    }
    for (const skill of wanted.values()) {
      const folder = join(root, skill.name);
      if (lstat(folder) && !ours(folder, tracked)) {
        result.skipped.push(skill.name);
        continue;
      }
      mkdirSync(folder, { recursive: true });
      writeOwn(join(folder, ".gitignore"), "*\n");
      writeOwn(join(folder, SKILL_FILE), skill.content);
      writeOwn(join(folder, SHARED_SKILL_MARKER), `${hash(skill.content)}\n`);
      result.written.push(skill.name);
    }
  }
  return result;
}
