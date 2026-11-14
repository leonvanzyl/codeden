import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  CODEDEN_CREDENTIAL_FILES,
  INVALID_COPY_SUFFIX,
  type WorkspaceFsErrorCode,
} from "@codeden/contracts";
import { agentPermissionPath } from "../policy/agent-permissions";

/**
 * The guards of workspace file access (`docs/remote-runners.md` §10), shared by the server's
 * own disk and the runner's `fs.*`/`transfer.*`, so a path is refused the same way wherever the
 * workspace lives: paths outside the root (lexically, then through links), CodeDen's own
 * credential files and the `.invalid-*` copies kept of damaged ones (§15), writes to an agent's
 * own allow-list (§11.2) and writes inside `.git`.
 */

/** A refused or failed workspace file operation, with a `WorkspaceFsErrorCode`. */
export class WorkspaceFsError extends Error {
  constructor(
    readonly code: WorkspaceFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFsError";
  }
}

const caseInsensitive = (platform: string) => platform === "win32" || platform === "darwin";

/** The path functions of a platform (`process.platform` values). */
export function platformPath(platform: string = process.platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** True when `child` is `root` or inside it (no `..` escape, no other drive). */
export function isInsidePath(root: string, child: string, platform: string = process.platform) {
  const p = platformPath(platform);
  const fold = (s: string) => (caseInsensitive(platform) ? s.toLowerCase() : s);
  const rel = p.relative(fold(root), fold(child));
  return rel === "" || (!rel.startsWith(`..${p.sep}`) && rel !== ".." && !p.isAbsolute(rel));
}

/**
 * Where `requested` (relative to `root`, or absolute) points, checked by its text only, with
 * the path rules of the machine the workspace is on. The server runs this before it asks a
 * runner for anything, so a path that escapes never leaves the server.
 */
export function lexicalTarget(
  root: string,
  requested: string,
  platform: string = process.platform,
) {
  if (requested.includes("\0") || root.includes("\0")) {
    throw new WorkspaceFsError("path_outside_root", "Invalid path");
  }
  const p = platformPath(platform);
  const target = p.resolve(p.resolve(root), requested);
  if (!isInsidePath(p.resolve(root), target, platform)) {
    throw new WorkspaceFsError("path_outside_root", "Path is outside the workspace");
  }
  return target;
}

/** Real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  let current = p;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return p;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  const real = realpathSync.native(current);
  return rest.length ? path.resolve(real, ...rest) : real;
}

/** Canonical form of a path on this machine, for comparing two paths. */
function canonical(p: string): string {
  const real = realish(path.resolve(p));
  return caseInsensitive(process.platform) ? real.toLowerCase() : real;
}

/**
 * The real path of a workspace root on this machine. Refused: a root that isn't an absolute
 * folder (`root_invalid`), one that doesn't exist (`cwd_missing`), CodeDen's data folder itself,
 * and its runner state folder (`<home>/runner`: the lock file token and the journal) or a folder
 * inside it.
 */
export function workspaceRoot(root: string, home: string): string {
  if (root.includes("\0") || !path.isAbsolute(root)) {
    throw new WorkspaceFsError("root_invalid", "The workspace root must be an absolute folder");
  }
  if (!existsSync(root)) {
    throw new WorkspaceFsError("cwd_missing", `${root} does not exist on this machine`);
  }
  const real = realpathSync.native(root);
  if (!statSync(real).isDirectory()) {
    throw new WorkspaceFsError("root_invalid", "The workspace root is not a folder");
  }
  const state = canonical(path.join(home, "runner"));
  const folded = caseInsensitive(process.platform) ? real.toLowerCase() : real;
  if (folded === canonical(home) || isInsidePath(state, folded)) {
    throw new WorkspaceFsError("root_invalid", "CodeDen's own folders are not a workspace");
  }
  return real;
}

/**
 * Resolve `requested` inside the workspace: by its text first, then through links (a link inside
 * the root must not point outside it). Returns the lexical and the real path.
 */
export function workspaceTarget(
  root: string,
  realRoot: string,
  requested: string,
): { target: string; real: string } {
  const target = lexicalTarget(root, requested);
  const real = realish(target);
  if (!isInsidePath(realRoot, real)) {
    throw new WorkspaceFsError("path_outside_root", "Path resolves outside the workspace");
  }
  return { target, real };
}

/** A real path relative to the real root, `/`-separated. */
export function workspaceRelative(realRoot: string, real: string): string {
  return path.relative(realRoot, real).split(path.sep).join("/");
}

/**
 * True when `file` is one of CodeDen's own credential files in `home` (§15), or a copy CodeDen
 * kept of one it found damaged (`<file>.invalid-<timestamp>` next to it, with the same secrets).
 */
export function isCodedenCredentialFile(file: string, home: string): boolean {
  const target = canonical(file);
  const fold = (s: string) => (caseInsensitive(process.platform) ? s.toLowerCase() : s);
  return CODEDEN_CREDENTIAL_FILES.some((name) => {
    const credential = path.join(home, name);
    if (canonical(credential) === target) return true;
    const copyPrefix = fold(`${path.basename(credential)}${INVALID_COPY_SUFFIX}`);
    return (
      path.dirname(target) === canonical(path.dirname(credential)) &&
      path.basename(target).startsWith(copyPrefix)
    );
  });
}

/** Refuse reading CodeDen's own credential files (and their `.invalid-*` copies). */
export function assertWorkspaceReadable(real: string, home: string): void {
  if (isCodedenCredentialFile(real, home)) {
    throw new WorkspaceFsError(
      "credential_file",
      `${path.basename(real)} is one of CodeDen's own credential files, which are never read`,
    );
  }
}

/**
 * Refuse writing inside `.git` and an agent's own allow-list (`.cursor/cli.json`,
 * `.gemini/settings.json`, ...), whose rules would run tools without CodeDen asking (§11.2).
 * Also refuses the credential files, which are never written either.
 */
export function assertWorkspaceWritable(realRoot: string, real: string, home: string): void {
  const rel = workspaceRelative(realRoot, real);
  if (rel.split("/").some((part) => part.toLowerCase() === ".git")) {
    throw new WorkspaceFsError("protected_path", "Files inside .git are never written");
  }
  const owner = agentPermissionPath(rel, { cwd: realRoot })?.owner;
  if (owner) {
    throw new WorkspaceFsError(
      "agent_permission_file",
      `${rel} holds ${owner}'s own permissions, which CodeDen never writes`,
    );
  }
  assertWorkspaceReadable(real, home);
}
