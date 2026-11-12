import type {
  AgentConfigDiff,
  AgentConfigProvider,
  McpConfigScope,
  McpServerEntry,
  McpServerTarget,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Loader2, PlugZap } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { emptyMcpForm, formToSpec, type McpForm, mcpFormValid, specToForm } from "./mcp-form";
import { McpTestResultView, useMcpTest } from "./mcp-test-result";
import { PatchDialog } from "./patch-dialog";

const SCOPES: Record<AgentConfigProvider, { value: McpConfigScope; label: string }[]> = {
  claude: [
    { value: "user", label: "User" },
    { value: "local", label: "Local (this project, private)" },
    { value: "project", label: "Project (.mcp.json)" },
  ],
  codex: [{ value: "user", label: "User (config.toml)" }],
};

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * Add or edit one MCP server in the provider's native config (Claude: ~/.claude.json or
 * .mcp.json; Codex: config.toml). Saving goes through a server-side diff preview first.
 */
export function McpServerDialog({
  open,
  onOpenChange,
  projectId,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  /** The server being edited (provider, scope and name are then fixed). */
  editing: McpServerEntry | null;
  onSaved: () => void;
}) {
  const client = useClient();
  const [provider, setProvider] = useState<AgentConfigProvider>("claude");
  const [scope, setScope] = useState<McpConfigScope>("user");
  const [name, setName] = useState("");
  const [form, setForm] = useState<McpForm>(emptyMcpForm);
  const [diff, setDiff] = useState<AgentConfigDiff | undefined>();
  const [diffError, setDiffError] = useState<string | null>(null);
  const [review, setReview] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing && editing.provider !== "codeden") {
      setProvider(editing.provider);
      setScope(editing.scope);
      setName(editing.name);
      setForm(specToForm(editing.spec));
    } else {
      setProvider("claude");
      setScope("user");
      setName("");
      setForm(emptyMcpForm);
    }
  }, [open, editing]);

  const set = (patch: Partial<McpForm>) => setForm((f) => ({ ...f, ...patch }));
  const target: McpServerTarget = {
    provider,
    scope,
    name,
    ...(scope !== "user" && projectId ? { projectId } : {}),
  };
  const spec = formToSpec(form, {
    supportsEnabled: provider === "codex",
    previous: editing?.provider === provider ? editing.spec : undefined,
  });
  const needsProject = scope !== "user" && !projectId;
  const nameValid = /^[A-Za-z0-9_.-]+$/.test(name);
  const valid = nameValid && mcpFormValid(form) && !needsProject;
  // The test needs no name: it runs the values in the form, saved or not.
  const testable = mcpFormValid(form) && !needsProject;

  // A result describes the values it tested: it goes when they change or the dialog reopens.
  const test = useMcpTest();
  const resetTest = test.reset;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the tested values change
  useEffect(() => resetTest(), [open, provider, scope, form, resetTest]);
  const runTest = () => void test.run({ ...target, name: nameValid ? name : "unsaved", spec });

  const preview = async () => {
    setDiff(undefined);
    setDiffError(null);
    setReview(true);
    try {
      setDiff(await client.agentConfig.diffMcp({ ...target, spec }));
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = useMutation({
    mutationFn: () => client.agentConfig.upsertMcp({ ...target, spec }),
    onSuccess: (res) => {
      toast.success(`Saved ${name}`, {
        description: res.backupPath ? `Backup: ${res.backupPath}` : res.file,
      });
      setReview(false);
      onOpenChange(false);
      onSaved();
    },
    onError: (e) => toast.error("Not saved", { description: e.message }),
  });

  const locked = editing !== null;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl" data-testid="mcp-server-dialog">
          <DialogHeader>
            <DialogTitle>{locked ? `Edit ${editing.name}` : "Add MCP server"}</DialogTitle>
            <DialogDescription>
              Written to the provider's own config, with a diff preview and a backup first. Test the
              connection before you save.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!locked && (
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  value={provider}
                  onChange={(p) => {
                    setProvider(p);
                    setScope("user");
                    if (p === "codex" && form.type === "sse") set({ type: "http" });
                  }}
                  options={[
                    { value: "claude", label: "Claude Code" },
                    { value: "codex", label: "Codex" },
                  ]}
                />
                <Segmented value={scope} onChange={setScope} options={SCOPES[provider]} />
              </div>
            )}
            {needsProject && (
              <p className="text-2xs text-status-waiting">
                Pick a project above to use this scope.
              </p>
            )}
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field id="mcp-name" label="Name">
                <Input
                  id="mcp-name"
                  value={name}
                  disabled={locked}
                  onChange={(e) => setName(e.target.value.trim())}
                  placeholder="playwright"
                  className="font-mono"
                />
              </Field>
              <Segmented
                value={form.type}
                onChange={(type) => set({ type })}
                options={[
                  { value: "stdio", label: "Command" },
                  { value: "http", label: "HTTP" },
                  ...(provider === "claude" ? [{ value: "sse" as const, label: "SSE" }] : []),
                ]}
              />
            </div>
            {form.type === "stdio" ? (
              <>
                <Field id="mcp-command" label="Command">
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(e) => set({ command: e.target.value })}
                    placeholder="npx"
                    className="font-mono text-xs"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field id="mcp-args" label="Arguments (one per line)">
                    <Textarea
                      id="mcp-args"
                      rows={3}
                      value={form.args}
                      onChange={(e) => set({ args: e.target.value })}
                      placeholder="@playwright/mcp@latest"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field id="mcp-env" label="Environment (KEY=value)">
                    <Textarea
                      id="mcp-env"
                      rows={3}
                      value={form.env}
                      onChange={(e) => set({ env: e.target.value })}
                      placeholder="DEBUG=1"
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field id="mcp-url" label="URL">
                  <Input
                    id="mcp-url"
                    value={form.url}
                    onChange={(e) => set({ url: e.target.value })}
                    placeholder="https://example.com/mcp"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field id="mcp-headers" label="Headers (Name: value)">
                  <Textarea
                    id="mcp-headers"
                    rows={2}
                    value={form.headers}
                    onChange={(e) => set({ headers: e.target.value })}
                    placeholder="Authorization: Bearer ${TOKEN}"
                    className="font-mono text-xs"
                  />
                </Field>
                {provider === "codex" && (
                  <Field id="mcp-bearer" label="Bearer token environment variable">
                    <Input
                      id="mcp-bearer"
                      value={form.bearerTokenEnvVar}
                      onChange={(e) => set({ bearerTokenEnvVar: e.target.value })}
                      placeholder="MY_SERVICE_TOKEN"
                      className="font-mono text-xs"
                    />
                  </Field>
                )}
              </>
            )}
            {provider === "codex" && (
              <div className="flex items-center gap-2 text-xs">
                <Switch
                  id="mcp-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => set({ enabled })}
                />
                <Label htmlFor="mcp-enabled" className="text-xs">
                  Enabled
                </Label>
              </div>
            )}
            {test.state && <McpTestResultView state={test.state} onDismiss={test.reset} />}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={!testable || test.state?.status === "running"}
              title="Start or reach the server with these values and list its tools"
              onClick={runTest}
            >
              {test.state?.status === "running" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <PlugZap />
              )}
              Test
            </Button>
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
        title={`Review ${name || "server"}`}
        diff={diff}
        error={diffError}
        onConfirm={() => save.mutate()}
        saving={save.isPending}
      />
    </>
  );
}
