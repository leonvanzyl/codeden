import type { DiffFile, DiffScope, RestoreFilesRequest } from "@codeden/contracts";
import type { SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Columns2,
  FileDiff,
  RefreshCw,
  RotateCcw,
  Rows2,
  WrapText,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, useClient } from "@/lib/api";
import { captureRange, diffScopeKey } from "@/lib/diff-review";
import { ageShort } from "@/lib/format";
import { useSession } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { sessionComments, useDiffReviewStore } from "@/stores/diff-review";
import { useResolvedTheme } from "@/stores/theme";
import { LineComments, ReviewBar, useReviewAnnotations } from "./diff-review";
import { GitBar } from "./git-bar";

function scopeLabel(scope: DiffScope, turns: { id: string; label: string }[]): string {
  if (scope.kind === "session") return "All changes";
  if (scope.kind === "uncommitted") return "Uncommitted";
  return turns.find((t) => t.id === scope.turnId)?.label ?? "Turn";
}

/** Where "restore" puts files back to: the session baseline, or the state before a turn. */
function restoreTarget(scope: DiffScope): Omit<RestoreFilesRequest, "paths"> | null {
  if (scope.kind === "session") return { index: 0 };
  if (scope.kind === "turn") return { turnId: scope.turnId };
  return null;
}

/** Session and per-turn diffs from checkpoints, with file restore (§9, §12.3). */
export function DiffPanel({ sessionId }: { sessionId: string }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const theme = useResolvedTheme();
  const session = useSession(sessionId);
  const [scope, setScope] = useState<DiffScope>({ kind: "session" });
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(true);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["diff", sessionId, scope],
    queryFn: () => client.getDiff(sessionId, scope),
    retry: false,
  });
  const restore = useMutation({
    mutationFn: (paths?: string[]) => {
      const target = restoreTarget(scope);
      if (!target) throw new Error("Pick a turn or the whole session to restore");
      return client.restoreFiles(sessionId, { ...target, ...(paths ? { paths } : {}) });
    },
    onSuccess: (r) => {
      const n = r.restored.length + r.deleted.length;
      toast.success(n ? `Restored ${n} file${n === 1 ? "" : "s"}` : "Nothing to restore");
      for (const key of ["diff", "files", "file", "git-status"]) {
        void queryClient.invalidateQueries({ queryKey: [key, sessionId] });
      }
    },
    onError: (e) => toast.error("Restore failed", { description: e.message }),
  });
  const files = data?.files ?? [];
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const noCheckpoints = error instanceof ApiRequestError && error.code === "no_checkpoints";
  const canRestore = restoreTarget(scope) !== null && files.length > 0;
  const scopeKey = diffScopeKey(scope);

  return (
    <div className="flex h-full flex-col" data-testid="diff-panel">
      <GitBar sessionId={sessionId} title={session?.title ?? session?.purpose ?? "Update"} />
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 whitespace-nowrap scroll-thin pointer-coarse:h-auto pointer-coarse:min-h-12">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 text-xs">
              {scopeLabel(scope, data?.turns ?? [])}
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={() => setScope({ kind: "session" })}>
              All changes in this session
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setScope({ kind: "uncommitted" })}>
              Uncommitted
            </DropdownMenuItem>
            {(data?.turns.length ?? 0) > 0 && <DropdownMenuSeparator />}
            {(data?.turns.length ?? 0) > 0 && (
              <DropdownMenuLabel className="text-2xs">By turn</DropdownMenuLabel>
            )}
            {[...(data?.turns ?? [])].reverse().map((t) => (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => setScope({ kind: "turn", turnId: t.id })}
              >
                <span className="flex-1">{t.label}</span>
                <span className="text-2xs text-muted-foreground">{ageShort(t.at)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {files.length > 0 && (
          <span className="text-2xs text-muted-foreground tabular-nums">
            {files.length} files · <span className="text-diff-add">+{add}</span>{" "}
            <span className="text-diff-del">−{del}</span>
          </span>
        )}
        <div className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => {
              void refetch();
              void queryClient.invalidateQueries({ queryKey: ["git-status", sessionId] });
            }}
            aria-label="Refresh diff"
            title="Refresh"
          >
            <RefreshCw className={cn(isFetching && "animate-spin")} />
          </Button>
          {canRestore && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              disabled={restore.isPending}
              onClick={() => {
                if (window.confirm("Put every file in this diff back to how it was?"))
                  restore.mutate(undefined);
              }}
              title={
                scope.kind === "turn" ? "Undo this turn's file changes" : "Undo all session changes"
              }
            >
              <RotateCcw /> Restore
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("text-muted-foreground", wrap && "text-foreground")}
            onClick={() => setWrap((v) => !v)}
            aria-label="Toggle wrap"
            title="Wrap lines"
          >
            <WrapText />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => setSplit((v) => !v)}
            aria-label="Toggle split view"
            title={split ? "Unified" : "Split"}
          >
            {split ? <Rows2 /> : <Columns2 />}
          </Button>
        </div>
      </div>
      {session && <ReviewBar session={session} scopeKey={scopeKey} />}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error && !noCheckpoints ? (
          <EmptyState icon={<FileDiff />} title="Couldn't load the diff" className="h-full">
            {error.message}
          </EmptyState>
        ) : files.length === 0 ? (
          <EmptyState icon={<FileDiff />} title="No changes yet" className="h-full">
            {noCheckpoints
              ? "Diffs appear once the session's first checkpoint is written."
              : "Diffs appear here from the session's turn checkpoints."}
          </EmptyState>
        ) : (
          <div className="space-y-3 p-2">
            {files.map((f) => (
              <FilePatch
                key={f.path}
                sessionId={sessionId}
                scopeKey={scopeKey}
                file={f}
                options={{ theme, split, wrap }}
                onRestore={canRestore ? () => restore.mutate([f.path]) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilePatch({
  sessionId,
  scopeKey,
  file,
  options,
  onRestore,
}: {
  sessionId: string;
  scopeKey: string;
  file: DiffFile;
  options: { theme: "dark" | "light"; split: boolean; wrap: boolean };
  onRestore?: () => void;
}) {
  const annotations = useReviewAnnotations(sessionId, file.path, scopeKey);
  // Lines picked with the line numbers; otherwise the open comment's lines stay highlighted.
  const [picked, setPicked] = useState<SelectedLineRange | null>(null);
  // The range object is kept while its comment is typed, so typing doesn't re-render the diff.
  const editingRange = useDiffReviewStore(
    (s) =>
      sessionComments(s, sessionId).findLast(
        (c) => c.path === file.path && c.scopeKey === scopeKey && c.draft !== undefined,
      )?.range,
  );
  const onComment = useCallback(
    (selected: SelectedLineRange) => {
      const { range, quote } = captureRange(file.patch, selected);
      useDiffReviewStore.getState().start(sessionId, { path: file.path, scopeKey, range, quote });
      // The view reports the selection again right after this call; let it go.
      queueMicrotask(() => setPicked(null));
    },
    [sessionId, scopeKey, file.path, file.patch],
  );
  return (
    <div
      className="group relative overflow-hidden rounded-lg border border-border"
      data-file={file.path}
    >
      {onRestore && (
        <Button
          variant="secondary"
          size="xs"
          className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100"
          onClick={onRestore}
          title={`Restore ${file.path}`}
        >
          <RotateCcw /> Restore file
        </Button>
      )}
      {file.binary ? (
        <div className="px-3 py-2 font-mono text-xs text-muted-foreground">
          {file.path} · binary file changed
        </div>
      ) : (
        <PatchDiff
          patch={file.patch}
          options={{
            theme: { dark: "pierre-dark", light: "pierre-light" },
            themeType: options.theme,
            diffStyle: options.split ? "split" : "unified",
            overflow: options.wrap ? "wrap" : "scroll",
            stickyHeader: true,
            // A "+" by the hovered line (or the picked lines) starts a comment; drag it for a range.
            enableGutterUtility: true,
            enableLineSelection: true,
            onGutterUtilityClick: onComment,
            onLineSelected: setPicked,
          }}
          selectedLines={picked ?? editingRange ?? null}
          lineAnnotations={annotations}
          renderAnnotation={(a) => (
            <LineComments
              sessionId={sessionId}
              path={file.path}
              scopeKey={scopeKey}
              side={a.side}
              line={a.lineNumber}
            />
          )}
        />
      )}
    </div>
  );
}
