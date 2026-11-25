import { File as FileView } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Files, Folder, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/common/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import type { FileNode } from "@/lib/api/types";
import { buildFileTree } from "@/lib/file-tree";
import { useDiffThemes } from "@/lib/theme/diff-theme";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "@/stores/theme";

const statusColor = {
  added: "text-diff-add",
  modified: "text-status-waiting",
  deleted: "text-diff-del",
};

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1 && (node.children?.length ?? 0) < 40);
  const isDir = node.kind === "dir";
  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? setOpen((v) => !v) : onSelect(node.path))}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={cn(
          "flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-foreground/85 hover:bg-accent/60",
          selected === node.path && "bg-accent text-foreground",
        )}
      >
        {isDir ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3" />
        )}
        {isDir ? (
          open ? (
            <FolderOpen className="size-3.5 shrink-0 text-primary/70" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-primary/70" />
          )
        ) : (
          <File className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("truncate", node.status && statusColor[node.status])}>{node.name}</span>
        {node.status && (
          <span className={cn("ml-auto font-mono text-3xs", statusColor[node.status])}>
            {node.status[0]?.toUpperCase()}
          </span>
        )}
      </button>
      {isDir &&
        open &&
        node.children?.map((c) => (
          <TreeNode
            key={c.path}
            node={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

/** The session folder's file tree (worktree or in place) plus a highlighted viewer (§12.3). */
export function FilesPanel({ sessionId }: { sessionId: string }) {
  const client = useClient();
  const theme = useResolvedTheme();
  const syntax = useDiffThemes();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["files", sessionId],
    queryFn: () => client.listFiles(sessionId),
  });
  const git = useQuery({
    queryKey: ["git-status", sessionId],
    queryFn: () => client.gitStatus(sessionId),
    retry: false,
  });
  const tree = useMemo(
    () => (list.data ? buildFileTree(list.data.entries, git.data?.files) : []),
    [list.data, git.data],
  );
  const file = useQuery({
    queryKey: ["file", sessionId, selected],
    queryFn: () => client.readFile(sessionId, selected ?? ""),
    enabled: Boolean(selected),
    retry: false,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[42%] shrink-0 overflow-y-auto border-b border-border p-1.5 scroll-thin">
        {list.error ? (
          <div className="p-2 text-xs text-status-failed">{list.error.message}</div>
        ) : list.isLoading ? (
          <div className="space-y-1.5 p-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-3/4" />
            ))}
          </div>
        ) : (
          tree.map((n) => (
            <TreeNode key={n.path} node={n} depth={0} selected={selected} onSelect={setSelected} />
          ))
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        {!selected ? (
          <EmptyState icon={<Files />} title="Pick a file" className="h-full">
            Browse the session's folder.
          </EmptyState>
        ) : file.error ? (
          <EmptyState icon={<Files />} title="Can't show this file" className="h-full">
            {file.error.message}
          </EmptyState>
        ) : file.data?.binary ? (
          <EmptyState icon={<Files />} title="Binary file" className="h-full">
            {file.data.path} isn't shown as text.
          </EmptyState>
        ) : file.data ? (
          <FileView
            file={{ name: file.data.path, contents: file.data.content }}
            options={{
              theme: syntax,
              themeType: theme,
              overflow: "scroll",
              stickyHeader: true,
            }}
          />
        ) : (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${50 + ((i * 17) % 45)}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
