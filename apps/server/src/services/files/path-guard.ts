import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { forbidden } from "../errors";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

/** Real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  let current = p;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return p;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  const real = realpathSync.native(current);
  return rest.length ? resolve(real, ...rest) : real;
}

/**
 * The real path of an existing file or folder (symlinks, junctions and Windows short names
 * resolved), or `undefined` when it doesn't exist.
 */
export function realPathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** True when `child` is `root` or inside it (no `..` escape, no other drive). */
export function isInside(root: string, child: string): boolean {
  const a = caseInsensitive ? root.toLowerCase() : root;
  const b = caseInsensitive ? child.toLowerCase() : child;
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve `requested` (relative to `root`, or absolute) and make sure it stays inside `root`,
 * following symlinks so a link inside the root cannot point outside it. Throws 403 otherwise.
 * Returns the absolute (lexical) path.
 */
export function resolveInside(root: string, requested: string): string {
  if (requested.includes("\0")) throw forbidden("Invalid path", "path_outside_root");
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, requested);
  if (!isInside(absoluteRoot, target)) {
    throw forbidden("Path is outside the allowed folder", "path_outside_root");
  }
  if (!isInside(realish(absoluteRoot), realish(target))) {
    throw forbidden("Path resolves outside the allowed folder", "path_outside_root");
  }
  return target;
}
