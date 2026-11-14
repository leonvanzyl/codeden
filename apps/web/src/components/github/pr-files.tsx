import type { GithubPrDetails, GithubPrDiffFile, GithubPrFile } from "@codeden/contracts";
import { PatchDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FileCode2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "@/stores/theme";

/** "Expand all" renders every diff at once, so it is offered up to this many files. */
const EXPAND_ALL_MAX = 100;

/** The PR's "Files changed" page on GitHub. */
function filesUrl(pr: GithubPrDetails): string {
  return `${pr.url}/files`;
}

function OpenOnGithub({ pr, label = "Open on GitHub" }: { pr: GithubPrDetails; label?: string }) {
  return (
    <Button
      variant="link"
      size="xs"
      className="h-auto px-0 text-2xs"
      onClick={() => platform.openExternal(filesUrl(pr))}
    >
      {label} <ExternalLink className="size-3" />
    </Button>
  );
}

/** The `Files changed` header action: expand or collapse every file's diff. */
export function PrFilesToggle({
  pr,
  open,
  onChange,
}: {
  pr: GithubPrDetails;
  open: ReadonlySet<string>;
  onChange: (open: ReadonlySet<string>) => void;
}) {
  if (pr.files.length === 0 || pr.files.length > EXPAND_ALL_MAX) return null;
  const allOpen = open.size === pr.files.length;
  return (
    <Button
      variant="ghost"
      size="xs"
      className="h-5 px-1.5 text-2xs font-normal tracking-normal normal-case"
      onClick={() => onChange(allOpen ? new Set() : new Set(pr.files.map((f) => f.path)))}
    >
      {allOpen ? "Collapse all" : "Expand all"}
    </Button>
  );
}

/**
 * Every changed file of a PR (§12.3); a row expands to the file's diff from GitHub. Patches are
 * fetched once the first file is opened, and again when the PR's head commit moves.
 */
export function PrFiles({
  pr,
  open,
  onToggle,
}: {
  pr: GithubPrDetails;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const client = useClient();
  const diff = useQuery({
    queryKey: ["github", "pr-diff", pr.id, pr.headSha],
    queryFn: () => client.github.prDiff(pr.id),
    enabled: open.size > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const byPath = useMemo(
    () => new Map((diff.data?.files ?? []).map((f) => [f.path, f])),
    [diff.data],
  );
  const truncated = pr.changedFiles > pr.files.length;

  return (
    <div className="space-y-2">
      <div className="divide-y divide-border overflow-clip rounded-lg border border-border">
        {pr.files.map((f) => {
          const isOpen = open.has(f.path);
          return (
            <div key={f.path} data-file={f.path}>
              <FileRow file={f} open={isOpen} onToggle={() => onToggle(f.path)} />
              {isOpen && (
                <div className="border-t border-border">
                  {diff.isLoading ? (
                    <Skeleton className="m-2 h-16" />
                  ) : diff.error ? (
                    <p className="px-3 py-2 text-xs text-status-failed">{diff.error.message}</p>
                  ) : (
                    <FileDiffBody pr={pr} file={f} diff={byPath.get(f.path)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {pr.files.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No files changed.</p>
        )}
      </div>
      {truncated && (
        <p className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
          GitHub lists the first {pr.files.length} of {pr.changedFiles} files.
          <OpenOnGithub pr={pr} label="See the rest on GitHub" />
        </p>
      )}
    </div>
  );
}

function FileRow({
  file,
  open,
  onToggle,
}: {
  file: GithubPrFile;
  open: boolean;
  onToggle: () => void;
}) {
  const name = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-2 bg-background px-3 py-1.5 text-left text-[12px] hover:bg-accent/40",
        open && "sticky top-0 z-10",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono" title={name}>
        {name}
      </span>
      <span className="text-3xs text-muted-foreground">{file.status}</span>
      <span className="text-3xs text-diff-add tabular-nums">+{file.additions}</span>
      <span className="text-3xs text-diff-del tabular-nums">−{file.deletions}</span>
    </button>
  );
}

function FileDiffBody({
  pr,
  file,
  diff,
}: {
  pr: GithubPrDetails;
  file: GithubPrFile;
  diff: GithubPrDiffFile | undefined;
}) {
  const theme = useResolvedTheme();
  if (diff?.patch) {
    return (
      <PatchDiff
        patch={diff.patch}
        options={{
          theme: { dark: "pierre-dark", light: "pierre-light" },
          themeType: theme,
          diffStyle: "unified",
          overflow: "wrap",
          disableFileHeader: true,
        }}
      />
    );
  }
  const message = !diff
    ? "This file is no longer in the pull request's latest diff."
    : file.status === "renamed" && file.additions + file.deletions === 0
      ? "Renamed without content changes."
      : "GitHub shows no diff for this file (binary, empty or too large).";
  return (
    <div className="flex flex-wrap items-center gap-x-2 px-3 py-2 text-xs text-muted-foreground">
      {message}
      {diff && <OpenOnGithub pr={pr} />}
    </div>
  );
}

/** Which files of a PR have their diff open. */
export function useOpenFiles() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return { open, setOpen, toggle };
}
