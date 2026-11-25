import type { DiffFile } from "@codeden/contracts";

/**
 * How much of a session's diff the Diff panel draws at once. Every file's patch becomes a
 * syntax-highlighted DOM tree, so a diff of thousands of files or a million lines (a branch
 * reset onto another branch, generated fixtures, a lockfile) would stall the window for good:
 * the panel reopens on the next launch and stalls it again.
 */
export const DIFF_LIMITS = {
  /** Files drawn at first, and added by each "Show more files". */
  filesPerPage: 50,
  /** A file with more changed lines than this starts collapsed. */
  largePatchLines: 2000,
  /** A file whose patch is longer than this starts collapsed (minified files have long lines). */
  largePatchChars: 200_000,
} as const;

/** Whether a file's diff is too big to draw before someone asks for it. */
export function isLargePatch(file: Pick<DiffFile, "additions" | "deletions" | "patch">): boolean {
  return (
    file.additions + file.deletions > DIFF_LIMITS.largePatchLines ||
    file.patch.length > DIFF_LIMITS.largePatchChars
  );
}

/**
 * The files to draw: the first `shown`, plus any later file `keep` asks for (one with review
 * comments, so a comment can always be shown in its place), in diff order.
 */
export function visibleFiles(
  files: readonly DiffFile[],
  shown: number,
  keep: (file: DiffFile) => boolean,
): DiffFile[] {
  if (files.length <= shown) return [...files];
  return files.filter((f, i) => i < shown || keep(f));
}
