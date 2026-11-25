import type { DiffFile } from "@codeden/contracts";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** A file whose diff is too big to draw up front (`isLargePatch`): its name, counts and a way in. */
export function CollapsedFile({
  file,
  actions,
  onOpen,
}: {
  file: DiffFile;
  actions: ReactNode;
  onOpen: () => void;
}) {
  const lines = file.additions + file.deletions;
  return (
    <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {file.path} · <span className="text-diff-add">+{file.additions}</span>{" "}
        <span className="text-diff-del">−{file.deletions}</span> · large diff hidden
      </span>
      {actions}
      <Button
        variant="secondary"
        size="xs"
        onClick={onOpen}
        title={`Draw all ${lines.toLocaleString()} changed lines; this can take a while`}
      >
        Show diff
      </Button>
    </div>
  );
}

/** Below a page of a big diff: how many files are drawn, and a button for the next page. */
export function MoreFiles({
  drawn,
  total,
  onMore,
}: {
  drawn: number;
  total: number;
  onMore: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        Showing {drawn.toLocaleString()} of {total.toLocaleString()} changed files
      </span>
      <Button variant="secondary" size="xs" onClick={onMore}>
        Show more files
      </Button>
    </div>
  );
}
