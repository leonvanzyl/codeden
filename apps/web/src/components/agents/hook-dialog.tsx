import {
  type AgentConfigDiff,
  type AgentConfigProvider,
  type AgentConfigScope,
  type HookChangeRequest,
  type HookEntry,
  type HookListResponse,
  type HookSource,
  KNOWN_CLAUDE_HOOK_EVENTS,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Segmented } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import {
  type EditableHookType,
  emptyHookForm,
  entryToForm,
  formToHandler,
  HOOK_TYPE_LABELS,
  type HookForm,
  hookFormValid,
} from "./hook-form";
import { PatchDialog } from "./patch-dialog";

export const SCOPE_LABELS: Record<AgentConfigScope, string> = {
  user: "User",
  project: "Project (shared)",
  local: "Local (private)",
};
export const PROVIDER_LABELS: Record<AgentConfigProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The request that saves the form: `add`, or `update` of the hook being edited. */
export function hookTarget(e: HookEntry) {
  return {
    provider: e.provider,
    scope: e.scope,
    ...(e.projectId ? { projectId: e.projectId } : {}),
    event: e.event,
    groupIndex: e.groupIndex ?? 0,
    handlerIndex: e.handlerIndex ?? 0,
    expected: e.handler,
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && <p className="text-3xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Add or edit one hook in a provider's settings file (only its `hooks` key changes). The file
 * choices come from the server's list of sources; saving goes through a diff preview first.
 */
export function HookDialog({
  open,
  onOpenChange,
  projectId,
  sources,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project picked on the page (the list returned after saving is for it). */
  projectId: string | null;
  /** Settings files that can take hooks (from `listHooks`). */
  sources: HookSource[];
  /** The hook being edited (its file is then fixed). */
  editing: HookEntry | null;
  /** Called with the hooks as they are after the save. */
  onSaved: (hooks: HookListResponse) => void;
}) {
  const client = useClient();
  const writable = sources.filter((s) => !s.error);
  const [source, setSource] = useState<HookSource | undefined>(writable[0]);
  const [form, setForm] = useState<HookForm>(emptyHookForm);
  const [diff, setDiff] = useState<AgentConfigDiff | undefined>();
  const [diffError, setDiffError] = useState<string | null>(null);
  const [review, setReview] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setForm(editing ? entryToForm(editing) : emptyHookForm);
    setSource(writable[0]);
  }, [open, editing]);

  const set = (patch: Partial<HookForm>) => setForm((f) => ({ ...f, ...patch }));
  const providers = [...new Set(writable.map((s) => s.provider))];
  const scopes = writable.filter((s) => s.provider === source?.provider);
  const handler = formToHandler(form, editing?.handler);
  const request = (): HookChangeRequest | null => {
    // The matcher is sent exactly as typed: whitespace can matter in a regex.
    const placement = {
      event: form.event,
      matcher: form.matcher === "" ? undefined : form.matcher,
      handler,
      ...(projectId ? { listProjectId: projectId } : {}),
    };
    if (editing) return { action: "update", target: hookTarget(editing), ...placement };
    if (!source) return null;
    return {
      action: "add",
      provider: source.provider,
      scope: source.scope,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      ...placement,
    };
  };
  const valid = hookFormValid(form) && (editing !== null || source !== undefined);
  const events: string[] = [...KNOWN_CLAUDE_HOOK_EVENTS];
  if (!events.includes(form.event)) events.unshift(form.event);

  const preview = async () => {
    const req = request();
    if (!req) return;
    setDiff(undefined);
    setDiffError(null);
    setReview(true);
    try {
      setDiff(await client.agentConfig.diffHook(req));
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = useMutation({
    mutationFn: async () => {
      const req = request();
      if (!req) throw new Error("Pick a settings file");
      return client.agentConfig.changeHook(req);
    },
    onSuccess: (res) => {
      toast.success(`Saved the ${form.event} hook`, {
        description: res.backupPath ? `Backup: ${res.backupPath}` : (res.file ?? undefined),
      });
      setReview(false);
      onOpenChange(false);
      onSaved(res.hooks);
    },
    onError: (e) => toast.error("Not saved", { description: e.message }),
  });

  const typeInfo = HOOK_TYPE_LABELS[form.type];
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl" data-testid="hook-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.event} hook` : "Add hook"}</DialogTitle>
            <DialogDescription className="break-all">
              {editing
                ? editing.file
                : "Written to the hooks key of the settings file, with a diff preview and a backup first."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!editing && (
              <div className="flex flex-wrap items-center gap-3">
                {providers.length > 1 && source && (
                  <Segmented
                    value={source.provider}
                    onChange={(p) => setSource(writable.find((s) => s.provider === p))}
                    options={providers.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
                  />
                )}
                {source && (
                  <Segmented
                    value={source.scope}
                    onChange={(scope) => setSource(scopes.find((s) => s.scope === scope))}
                    options={scopes.map((s) => ({ value: s.scope, label: SCOPE_LABELS[s.scope] }))}
                  />
                )}
                {source && (
                  <p className="w-full truncate font-mono text-3xs text-muted-foreground">
                    {source.file}
                  </p>
                )}
                {scopes.length === 1 && (
                  <p className="text-3xs text-muted-foreground">
                    Pick a project at the top for project and local hooks.
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field id="hook-event" label="Event">
                <Select value={form.event} onValueChange={(event) => set({ event })}>
                  <SelectTrigger id="hook-event" className="w-full font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {events.map((e) => (
                      <SelectItem key={e} value={e} className="font-mono text-xs">
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id="hook-matcher"
                label="Matcher (optional)"
                hint="Tool name or regex. Empty matches everything; some events ignore it."
              >
                <Input
                  id="hook-matcher"
                  value={form.matcher}
                  onChange={(e) => set({ matcher: e.target.value })}
                  placeholder="Edit|Write"
                  className="font-mono text-xs"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Segmented<EditableHookType>
                value={form.type}
                onChange={(type) => set({ type })}
                options={Object.entries(HOOK_TYPE_LABELS).map(([value, t]) => ({
                  value: value as EditableHookType,
                  label: t.label,
                }))}
              />
              <div className="w-32">
                <Field id="hook-timeout" label="Timeout (seconds)">
                  <Input
                    id="hook-timeout"
                    inputMode="numeric"
                    value={form.timeout}
                    onChange={(e) => set({ timeout: e.target.value.trim() })}
                    placeholder="Default"
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
            </div>
            <Field id="hook-value" label={typeInfo.field}>
              {form.type === "command" || form.type === "http" ? (
                <Input
                  id="hook-value"
                  value={form.value}
                  onChange={(e) => set({ value: e.target.value })}
                  placeholder={
                    form.type === "command" ? "./scripts/format.sh" : "http://localhost:8080/hooks"
                  }
                  className="font-mono text-xs"
                />
              ) : (
                <Textarea
                  id="hook-value"
                  rows={3}
                  value={form.value}
                  onChange={(e) => set({ value: e.target.value })}
                  placeholder="Check that the tests were run before stopping."
                  className="text-xs"
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => void preview()}>
              Review & save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PatchDialog
        open={review}
        onOpenChange={setReview}
        title={`Review the ${form.event} hook`}
        diff={diff}
        error={diffError}
        onConfirm={() => save.mutate()}
        saving={save.isPending}
      />
    </>
  );
}
