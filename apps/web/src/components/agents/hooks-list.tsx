import type {
  AgentConfigDiff,
  HookChangeRequest,
  HookEntry,
  HookListResponse,
  HookSource,
} from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Power, PowerOff, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ProviderMark } from "@/components/common/bits";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HookDialog, hookTarget, PROVIDER_LABELS, SCOPE_LABELS } from "./hook-dialog";
import { hookSummary, isEditableHook } from "./hook-form";
import { PatchDialog } from "./patch-dialog";

const chip = "rounded-full border border-border px-1.5 py-px text-3xs text-muted-foreground";

const sourceKey = (s: Pick<HookSource, "provider" | "scope" | "projectId">) =>
  `${s.provider}:${s.scope}:${s.projectId ?? ""}`;
const hookKey = (h: HookEntry) =>
  h.shelfId ?? `${sourceKey(h)}:${h.event}:${h.groupIndex}:${h.handlerIndex}`;

/** A change waiting for its diff to be confirmed. */
interface Pending {
  title: string;
  confirmLabel: string;
  done: string;
  req: HookChangeRequest;
}

/** Hooks from each provider's settings files, by file (§12.4). */
export function HooksList({ projectId }: { projectId: string | null }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const queryKey = ["agent-config-hooks", projectId];
  const list = useQuery({ queryKey, queryFn: () => client.agentConfig.listHooks(projectId) });
  /** Every change returns the list as it is now, for this page's project. */
  const setHooks = (hooks: HookListResponse) => queryClient.setQueryData(queryKey, hooks);
  const view = projectId ? { listProjectId: projectId } : {};
  const [dialog, setDialog] = useState<{ editing: HookEntry | null } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [diff, setDiff] = useState<AgentConfigDiff | undefined>();
  const [diffError, setDiffError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<HookEntry | null>(null);

  const ask = async (next: Pending) => {
    setPending(next);
    setDiff(undefined);
    setDiffError(null);
    try {
      setDiff(await client.agentConfig.diffHook(next.req));
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    }
  };
  const change = useMutation({
    mutationFn: (p: Pending) => client.agentConfig.changeHook(p.req),
    onSuccess: (res, p) => {
      setPending(null);
      setForgetting(null);
      setHooks(res.hooks);
      toast.success(p.done, {
        description: res.backupPath ? `Backup: ${res.backupPath}` : (res.file ?? undefined),
      });
    },
    onError: (e) => toast.error("Not changed", { description: e.message }),
  });

  const sources = list.data?.sources ?? [];
  const hooks = list.data?.hooks ?? [];
  const label = (h: HookEntry) => `${h.event} hook${h.matcher ? ` (${h.matcher})` : ""}`;
  const remove = (h: HookEntry) => {
    if (h.shelfId) {
      setForgetting(h);
      return;
    }
    void ask({
      title: `Delete the ${label(h)}`,
      confirmLabel: "Delete hook",
      done: `Deleted the ${label(h)}`,
      req: { action: "remove", target: hookTarget(h), ...view },
    });
  };
  const toggle = (h: HookEntry) =>
    void ask(
      h.shelfId
        ? {
            title: `Enable the ${label(h)}`,
            confirmLabel: "Enable hook",
            done: `Enabled the ${label(h)}`,
            req: { action: "enable", target: { shelfId: h.shelfId }, ...view },
          }
        : {
            title: `Disable the ${label(h)}`,
            confirmLabel: "Disable hook",
            done: `Disabled the ${label(h)}`,
            req: { action: "disable", target: hookTarget(h), ...view },
          },
    );

  return (
    <div data-testid="hooks-list">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Hooks</h2>
          <p className="text-[13px] text-muted-foreground">
            Commands your agents run on lifecycle events, from each settings file's hooks key,
            edited in place.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!sources.some((s) => !s.error)}
          onClick={() => setDialog({ editing: null })}
        >
          <Plus /> Add hook
        </Button>
      </div>
      {list.isLoading && <Skeleton className="h-24 rounded-xl" />}
      {list.error && <p className="p-4 text-xs text-status-failed">{list.error.message}</p>}
      {list.data && hooks.length === 0 && sources.every((s) => !s.error) && (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={<Webhook />} title="No hooks configured">
            Add one to run a command before or after a tool call, when a prompt is sent or when the
            agent stops.
          </EmptyState>
        </div>
      )}
      <div className="space-y-4">
        {sources.map((source) => {
          const own = hooks.filter((h) => sourceKey(h) === sourceKey(source));
          // With no hooks at all, only files with something to say (an error, or
          // disableAllHooks) are shown under the empty state.
          const notice = source.error || source.disableAllHooks;
          if (own.length === 0 && !notice && hooks.length === 0) return null;
          return (
            <section
              key={sourceKey(source)}
              data-hook-source={source.scope}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <header className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
                <ProviderMark provider={source.provider} className="size-4" />
                <span className="text-[13px] font-medium">{SCOPE_LABELS[source.scope]}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-3xs text-muted-foreground">
                  {source.file}
                </span>
                <span className="hidden text-2xs text-muted-foreground lg:inline">
                  {PROVIDER_LABELS[source.provider]}
                </span>
              </header>
              {source.error && (
                <p className="flex items-center gap-2 px-4 py-2 text-xs text-status-failed">
                  <AlertTriangle className="size-3.5 shrink-0" /> {source.error}
                </p>
              )}
              {source.disableAllHooks && (
                <p className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-status-waiting">
                  <AlertTriangle className="size-3.5 shrink-0" /> This file sets disableAllHooks:
                  none of its hooks run.
                </p>
              )}
              {!source.error && own.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  No hooks in this file{source.exists ? "" : " (it doesn't exist yet)"}.
                </p>
              )}
              {own.map((h) => (
                <HookRow
                  key={hookKey(h)}
                  hook={h}
                  offByFile={source.disableAllHooks}
                  onEdit={() => setDialog({ editing: h })}
                  onToggle={() => toggle(h)}
                  onRemove={() => remove(h)}
                />
              ))}
            </section>
          );
        })}
      </div>
      <HookDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        projectId={projectId}
        sources={sources}
        editing={dialog?.editing ?? null}
        onSaved={setHooks}
      />
      <PatchDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.title ?? ""}
        diff={diff}
        error={diffError}
        onConfirm={() => pending && change.mutate(pending)}
        saving={change.isPending}
        confirmLabel={pending?.confirmLabel}
      />
      <AlertDialog open={forgetting !== null} onOpenChange={(open) => !open && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this disabled hook?</AlertDialogTitle>
            <AlertDialogDescription>
              It is no longer in {forgetting?.file ?? "its settings file"}, so only CodeDen's copy
              is removed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                forgetting?.shelfId &&
                change.mutate({
                  title: "",
                  confirmLabel: "",
                  done: `Deleted the ${label(forgetting)}`,
                  req: { action: "remove", target: { shelfId: forgetting.shelfId }, ...view },
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HookRow({
  hook: h,
  offByFile,
  onEdit,
  onToggle,
  onRemove,
}: {
  hook: HookEntry;
  offByFile: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const off = !h.enabled || offByFile;
  const name = `${h.event} ${h.matcher ?? ""}`.trim();
  return (
    <div
      data-hook={h.event}
      className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0"
    >
      <Webhook className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
          <span className={cn(off && "text-muted-foreground", !h.enabled && "line-through")}>
            {h.event}
          </span>
          <span className="rounded bg-muted px-1.5 py-px font-mono text-3xs font-normal text-muted-foreground">
            {h.matcher ?? "all"}
          </span>
          <span className={chip}>{h.handler.type}</span>
          {h.handler.timeout !== undefined && <span className={chip}>{h.handler.timeout}s</span>}
          {!h.enabled && <span className={chip}>disabled</span>}
        </div>
        <div className="truncate font-mono text-3xs text-muted-foreground">
          {hookSummary(h.handler)}
        </div>
      </div>
      <div className="flex gap-1">
        {h.enabled && isEditableHook(h.handler) && (
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${name}`} onClick={onEdit}>
            <Pencil />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${h.enabled ? "Disable" : "Enable"} ${name}`}
          title={h.enabled ? "Disable (keeps a copy in CodeDen)" : "Enable"}
          onClick={onToggle}
        >
          {h.enabled ? <PowerOff /> : <Power />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${name}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
