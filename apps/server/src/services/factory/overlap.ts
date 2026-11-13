import type { FactoryItem, Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { ownedPr } from "./pr-status";

/**
 * Overlap-aware scheduling (§10.1, Assign): before a queued item starts, the files it is likely
 * to touch are compared with the files the factory's open PRs change. An item that clearly
 * overlaps one waits behind items that don't, so fewer merges leave the others conflicting; it
 * still starts when nothing else is waiting (overlap only reorders, it never holds work).
 *
 * The estimate is the paths the work names: in its title, its issue's body and its acceptance
 * criteria. A review area (`ux`, `security`, ...) names no files, so it isn't used.
 */

/** Files changed by the factory's open PRs as last read from GitHub (verification, ownership). */
export class PrFiles {
  private readonly files = new Map<string, readonly string[]>();

  set(projectId: string, prNumber: number, files: readonly string[]): void {
    this.files.set(`${projectId}#${prNumber}`, files);
  }

  get(projectId: string, prNumber: number): readonly string[] | undefined {
    return this.files.get(`${projectId}#${prNumber}`);
  }
}

const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Two or more path segments: `apps/web/src/`, `docs/DESIGN.md`, `factory/loop.ts`. */
const PATH = /[\w.@-]+(?:\/[\w.@-]+)+\/?/g;
const EXTENSION = /\.[a-z0-9]{1,8}$/i;

/** Paths named in some text: files (with an extension) and directories (two or more segments). */
export function namedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(URL, " ").matchAll(PATH)) {
    const path = match[0]
      .replace(/^(\.{1,2}\/)+/, "")
      .replace(/\.+$/, "")
      .replace(/\/+$/, "");
    if (path.split("/").filter(Boolean).length >= 2) found.add(path);
  }
  return [...found];
}

/** The paths a queued item is likely to touch. */
export function itemPaths(item: Pick<FactoryItem, "title" | "summary" | "acceptanceCriteria">) {
  return namedPaths([item.title, item.summary, ...item.acceptanceCriteria].join("\n"));
}

/** Whether a named path clearly covers a changed file: the same file, or a directory holding it. */
export function covers(named: string, changed: string): boolean {
  if (EXTENSION.test(named.split("/").pop() ?? "")) {
    return changed === named || changed.endsWith(`/${named}`);
  }
  return changed.startsWith(`${named}/`) || changed.includes(`/${named}/`);
}

export interface OpenPrFiles {
  itemId: string;
  number: number;
  files: readonly string[];
}

/** The factory's open PRs whose changed files are known. */
export function openPrFiles(ctx: FactoryContext, project: Project): OpenPrFiles[] {
  const owning = ctx.store.items(project.id, [
    "backlog",
    "building",
    "verifying",
    "failed",
    "escalated",
  ]);
  return owning.flatMap((i) => {
    const pr = ownedPr(ctx, i);
    const files = pr ? ctx.prFiles.get(project.id, pr.number) : undefined;
    return pr && files ? [{ itemId: i.id, number: pr.number, files }] : [];
  });
}

/** The first open PR (not the item's own) that a named path clearly overlaps, if any. */
export function overlapOf(
  item: Pick<FactoryItem, "id" | "title" | "summary" | "acceptanceCriteria">,
  open: readonly OpenPrFiles[],
): { pr: number; path: string } | null {
  const paths = itemPaths(item);
  if (paths.length === 0) return null;
  for (const pr of open) {
    if (pr.itemId === item.id) continue;
    for (const named of paths) {
      const changed = pr.files.find((f) => covers(named, f));
      if (changed) return { pr: pr.number, path: changed };
    }
  }
  return null;
}

/** Repairs of the default branch: never held or reordered, everything else waits on them. */
export function repairsMain(item: Pick<FactoryItem, "source">): boolean {
  return item.source === "failed_check" || item.source === "revert";
}

/**
 * The queue in the order free agents take it: its order (`queueOrder`), except that items
 * clearly overlapping an open PR go after the ones that don't. Repairs of the default branch
 * keep their place.
 */
export function scheduleOrder<T extends FactoryItem>(
  queue: readonly T[],
  open: readonly OpenPrFiles[],
): Array<{ item: T; overlap: { pr: number; path: string } | null }> {
  const ranked = queue.map((item) => ({
    item,
    overlap: repairsMain(item) ? null : overlapOf(item, open),
  }));
  return [...ranked.filter((r) => !r.overlap), ...ranked.filter((r) => r.overlap)];
}
