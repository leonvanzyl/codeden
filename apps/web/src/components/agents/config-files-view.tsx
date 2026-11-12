import type { AgentConfigFile, AgentConfigKind } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { FilePlus2, FileText, FolderOpen, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EmptyState, ProviderMark } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConfigFileEditor } from "./config-file-editor";
import type { NewConfigKind } from "./config-templates";
import { NewConfigFileDialog } from "./new-config-file-dialog";

const PROVIDERS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;
const scopeOrder = { user: 0, project: 1, local: 2 };
const scopeTone = { user: "text-chart-2", project: "text-primary", local: "text-chart-4" };
const scopeLabel = { user: "user", project: "project", local: "local" };

export const fileKey = (f: Pick<AgentConfigFile, "root" | "projectId" | "path">) =>
  `${f.root}:${f.projectId ?? ""}:${f.path}`;

/** Extras a tab adds to a file's row (the Skills tab's switch). */
export interface RowAddon {
  /** Shown dimmed (a skill that is switched off). */
  muted?: boolean;
  /** Under the scope label. */
  chip?: ReactNode;
  /** A control at the row's end, outside its select button. */
  end?: ReactNode;
}

/** The agent-config file list for a project (or the user's home only), shared by the tabs. */
export function useAgentConfigFiles(projectId: string | null) {
  const client = useClient();
  return useQuery({
    queryKey: ["agent-config-files", projectId],
    queryFn: () => client.agentConfig.list({ projectId: projectId ?? undefined }),
  });
}

/**
 * Master-detail view of native agent-config files of some kinds (§12.4): grouped by provider,
 * edited in place with a diff preview. `create` adds a "New" button for skills or subagents;
 * `rowAddon` adds a control to rows, and `onFilesChanged` runs after a file is written,
 * created or deleted here.
 */
export function ConfigFilesView({
  projectId,
  kinds,
  create,
  placeholder,
  emptyText,
  rowAddon,
  onFilesChanged,
}: {
  projectId: string | null;
  kinds: AgentConfigKind[];
  create?: NewConfigKind;
  placeholder?: string;
  emptyText: string;
  rowAddon?: (file: AgentConfigFile) => RowAddon | undefined;
  onFilesChanged?: () => void;
}) {
  const files = useAgentConfigFiles(projectId);
  const changed = () => {
    void files.refetch();
    onFilesChanged?.();
  };
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = (files.data?.files ?? [])
    .filter((f) => kinds.includes(f.kind))
    .sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.path.localeCompare(b.path));
  const current =
    list.find((f) => fileKey(f) === selectedKey) ?? list.find((f) => f.exists) ?? list[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        {create && (
          <div className="border-b border-border p-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setCreating(true)}
            >
              <Plus /> New {create === "skill" ? "skill" : "subagent"}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2 scroll-thin">
          {files.isLoading && (
            <div className="space-y-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          )}
          {files.error && (
            <p className="p-2 text-xs text-status-failed">{(files.error as Error).message}</p>
          )}
          {PROVIDERS.map((p) => {
            const group = list.filter((f) => f.provider === p.id);
            if (group.length === 0) return null;
            return (
              <div key={p.id} className="mb-3">
                <div className="flex items-center gap-2 px-2 py-1.5 text-2xs font-medium text-muted-foreground">
                  <ProviderMark provider={p.id} /> {p.label}
                </div>
                {group.map((f) => (
                  <FileRow
                    key={fileKey(f)}
                    file={f}
                    active={current ? fileKey(current) === fileKey(f) : false}
                    onSelect={() => setSelectedKey(fileKey(f))}
                    addon={rowAddon?.(f)}
                  />
                ))}
              </div>
            );
          })}
          {files.data && list.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">{emptyText}</p>
          )}
          {files.data?.autoMemoryDir && kinds.includes("auto_memory") && (
            <p className="mt-2 flex items-start gap-1.5 px-2 text-3xs break-all text-muted-foreground/80">
              <FolderOpen className="mt-px size-3 shrink-0" /> Auto memory:{" "}
              {files.data.autoMemoryDir}
            </p>
          )}
        </div>
      </aside>
      {current ? (
        <ConfigFileEditor
          key={fileKey(current)}
          file={current}
          placeholder={placeholder}
          onChanged={changed}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={<FileText />} title="Nothing selected">
            {emptyText}
          </EmptyState>
        </div>
      )}
      {create && (
        <NewConfigFileDialog
          kind={create}
          projectId={projectId}
          open={creating}
          onOpenChange={setCreating}
          onCreated={(created) => {
            setSelectedKey(fileKey(created));
            changed();
          }}
        />
      )}
    </div>
  );
}

function FileRow({
  file: f,
  active,
  onSelect,
  addon,
}: {
  file: AgentConfigFile;
  active: boolean;
  onSelect: () => void;
  addon?: RowAddon;
}) {
  const label = f.kind === "skill" || f.kind === "subagent" ? f.name : f.path;
  return (
    <div
      className={cn("flex items-start rounded-md hover:bg-accent/60", active && "bg-accent")}
      data-muted={addon?.muted ? "true" : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        data-config-path={f.path}
        className={cn(
          "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left",
          addon?.muted && "opacity-55",
        )}
      >
        {f.exists ? (
          <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FilePlus2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px]", !f.exists && "text-muted-foreground")}>
            {label}
          </span>
          <span className="block truncate text-3xs text-muted-foreground">
            {f.description ?? (f.root === "home" ? `~/${f.path}` : f.path)}
          </span>
        </span>
        <span className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5 text-3xs">
          <span className={scopeTone[f.scope]}>{scopeLabel[f.scope]}</span>
          {f.onDemand && <span className="text-muted-foreground">on demand</span>}
          {f.kind === "auto_memory" && <span className="text-muted-foreground">auto</span>}
          {addon?.chip}
        </span>
      </button>
      {addon?.end && <span className="flex shrink-0 items-center py-2 pr-2">{addon.end}</span>}
    </div>
  );
}
