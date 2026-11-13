import type { AgentConfigDiff, McpServerEntry, McpServerTarget } from "@codeden/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Pencil, Plug, PlugZap, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ProviderMark } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { specSummary } from "./mcp-form";
import { McpServerDialog } from "./mcp-server-dialog";
import { McpTestResultView, useMcpTest } from "./mcp-test-result";
import { PatchDialog } from "./patch-dialog";

const scopeChip =
  "rounded-full border border-border px-1.5 py-px text-3xs capitalize text-muted-foreground";
const providerLabel = { claude: "Claude Code", codex: "Codex", codeden: "CodeDen" };

const entryKey = (s: McpServerEntry) => `${s.provider}:${s.scope}:${s.projectId ?? ""}:${s.name}`;

/** MCP servers from `.mcp.json`, Claude's user config and `~/.codex/config.toml` (§12.4). */
export function McpServers({ projectId }: { projectId: string | null }) {
  const client = useClient();
  const list = useQuery({
    queryKey: ["agent-config-mcp", projectId],
    queryFn: () => client.agentConfig.listMcp(projectId),
  });
  const [dialog, setDialog] = useState<{ editing: McpServerEntry | null } | null>(null);
  const [removing, setRemoving] = useState<McpServerEntry | null>(null);
  const [diff, setDiff] = useState<AgentConfigDiff | undefined>();
  const [diffError, setDiffError] = useState<string | null>(null);

  const target = (s: McpServerEntry) => ({
    provider: s.provider === "codex" ? ("codex" as const) : ("claude" as const),
    scope: s.scope,
    name: s.name,
    ...(s.projectId ? { projectId: s.projectId } : {}),
  });
  const askRemove = async (s: McpServerEntry) => {
    setRemoving(s);
    setDiff(undefined);
    setDiffError(null);
    try {
      setDiff(await client.agentConfig.diffMcp(target(s)));
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = useMutation({
    mutationFn: (s: McpServerEntry) => client.agentConfig.removeMcp(target(s)),
    onSuccess: (res, s) => {
      setRemoving(null);
      void list.refetch();
      toast.success(`Removed ${s.name}`, {
        description: res.backupPath ? `Backup: ${res.backupPath}` : res.file,
      });
    },
    onError: (e) => toast.error("Not removed", { description: e.message }),
  });

  const servers = list.data?.servers ?? [];
  return (
    <div data-testid="mcp-servers">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">MCP servers</h2>
          <p className="text-[13px] text-muted-foreground">
            .mcp.json, Claude's user config and ~/.codex/config.toml, edited in place.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialog({ editing: null })}>
          <Plus /> Add server
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {list.isLoading && <Skeleton className="m-3 h-10" />}
        {list.error && <p className="p-4 text-xs text-status-failed">{list.error.message}</p>}
        {list.data && servers.length === 0 && (
          <EmptyState icon={<Plug />} title="No MCP servers configured">
            Add one to give your agents extra tools.
          </EmptyState>
        )}
        {servers.map((s) => (
          <McpServerRow
            // A saved edit starts the row afresh, so no test result outlives its definition.
            key={`${entryKey(s)}:${JSON.stringify(s.spec)}`}
            server={s}
            testTarget={target(s)}
            onEdit={() => setDialog({ editing: s })}
            onRemove={() => void askRemove(s)}
          />
        ))}
      </div>
      <McpServerDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        projectId={projectId}
        editing={dialog?.editing ?? null}
        onSaved={() => void list.refetch()}
      />
      <PatchDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "server"}`}
        diff={diff}
        error={diffError}
        onConfirm={() => removing && remove.mutate(removing)}
        saving={remove.isPending}
        confirmLabel="Remove server"
      />
    </div>
  );
}

/** One configured server, with its connection test (not for CodeDen's own server). */
function McpServerRow({
  server: s,
  testTarget,
  onEdit,
  onRemove,
}: {
  server: McpServerEntry;
  /** Where the server is saved; the test runs the saved definition. */
  testTarget: McpServerTarget;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const test = useMcpTest();
  const running = test.state?.status === "running";
  return (
    <div data-mcp={s.name} className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex items-center gap-3">
        <Plug className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            <span className={cn(s.spec.enabled === false && "text-muted-foreground line-through")}>
              {s.name}
            </span>
            <span className="rounded bg-muted px-1.5 py-px font-mono text-3xs font-normal text-muted-foreground">
              {s.spec.type}
            </span>
            <span className={scopeChip}>{s.scope}</span>
            {s.provider === "codeden" && <span className={scopeChip}>built in</span>}
            {s.spec.enabled === false && <span className={scopeChip}>disabled</span>}
          </div>
          <div className="truncate font-mono text-3xs text-muted-foreground">
            {specSummary(s.spec)}
          </div>
          <div className="truncate text-3xs text-muted-foreground/70">from {s.file}</div>
        </div>
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <ProviderMark provider={s.provider} className="size-5" />
          <span className="hidden lg:inline">{providerLabel[s.provider]}</span>
        </span>
        {s.provider !== "codeden" && (
          <div className="flex gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Test ${s.name}`}
              title="Test the connection"
              disabled={running}
              onClick={() => void test.run(testTarget)}
            >
              {running ? <Loader2 className="animate-spin" /> : <PlugZap />}
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={onEdit}>
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${s.name}`}
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {test.state && (
        <McpTestResultView state={test.state} onDismiss={test.reset} className="mt-2 ml-7" />
      )}
    </div>
  );
}
