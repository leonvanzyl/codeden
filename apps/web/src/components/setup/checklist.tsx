import type { SetupCheck, SetupStatus } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  Loader2,
  LogIn,
  RefreshCw,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TerminalView } from "@/components/workbench/terminal-view";
import { useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { platform } from "@/lib/platform";
import { useSetupStatus, useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ClaudeSupportRow } from "./claude-support";

type RowState = SetupCheck["state"] | "checking";

/** Placeholder rows while the first detection runs. */
const PENDING: { id: string; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "cursor", label: "Cursor" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "gh", label: "GitHub CLI" },
  { id: "git", label: "git identity" },
  { id: "browser", label: "Browser for agents" },
];

const fixLabel: Record<NonNullable<SetupCheck["fix"]>["kind"], string> = {
  install: "Install",
  login: "Sign in",
  upgrade: "Upgrade",
  configure: "Set up",
};

function StateIcon({ state }: { state: RowState }) {
  const base =
    "flex size-6 shrink-0 items-center justify-center rounded-full transition-all duration-300";
  if (state === "checking")
    return (
      <span className={cn(base, "border border-border")}>
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      </span>
    );
  if (state === "ok")
    return (
      <span className={cn(base, "bg-status-done/15 text-status-done")}>
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (state === "warning")
    return (
      <span className={cn(base, "bg-status-waiting/15 text-status-waiting")}>
        <TriangleAlert className="size-3.5" />
      </span>
    );
  return (
    <span className={cn(base, "bg-status-failed/12 text-status-failed")}>
      <X className="size-3.5" strokeWidth={3} />
    </span>
  );
}

/**
 * What lies behind a check's message: copies of the tool that were found but do not run, and
 * the underlying error. Collapsed by default; nothing when the check has neither.
 */
function CheckDetails({ check }: { check: SetupCheck }) {
  const broken = check.broken ?? [];
  if (broken.length === 0 && !check.detail) return null;
  return (
    <details className="mt-1 text-2xs text-muted-foreground" data-testid="check-details">
      <summary className="cursor-pointer select-none">Details</summary>
      {broken.length > 0 && (
        <ul className="mt-1 space-y-1">
          {broken.map((b) => (
            <li key={b.path} className="break-all">
              <code className="font-mono">{b.path}</code> {b.reason}
              {b.target ? (
                <>
                  : <code className="font-mono">{b.target}</code>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {check.detail && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono">
          {check.detail}
        </pre>
      )}
    </details>
  );
}

/** Live setup status, shared by the checklist, the setup page and the model picker. */
export { useSetupStatus };

/** First-run checklist (§14): parallel checks with live ticks; one fix per failed check. */
export function SetupChecklist() {
  const client = useClient();
  const queryClient = useQueryClient();
  const [fixing, setFixing] = useState<SetupCheck | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const { data } = useSetupStatus();
  // Rows for the agent providers the runner loaded carry a "provider" tag (data, not ids).
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const providerIds = new Set(providers.map((p) => p.id));

  const recheck = async (focus?: SetupCheck) => {
    setRechecking(true);
    try {
      const next = await client.getSetupStatus({ refresh: true });
      queryClient.setQueryData<SetupStatus>(["setup"], next);
      const after = focus && next.checks.find((c) => c.id === focus.id);
      if (focus && after?.state === "ok") toast.success(`${focus.label} is ready`);
    } catch (e) {
      toast.error("Couldn't re-check", { description: (e as Error).message });
    } finally {
      setRechecking(false);
    }
  };
  const closeFix = () => {
    const check = fixing;
    setFixing(null);
    if (check) void recheck(check);
  };

  const rows: { id: string; label: string; check?: SetupCheck }[] = data
    ? data.checks.map((c) => ({ id: c.id, label: c.label, check: c }))
    : PENDING;

  return (
    <>
      <div
        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
        data-testid="setup-checklist"
      >
        {rows.map(({ id, label, check: c }) => {
          const state: RowState = !c || rechecking ? "checking" : c.state;
          // A check that isn't ok shows its whole reason: that's what the user needs to read.
          const needsAttention = state !== "ok" && state !== "checking";
          return (
            <Fragment key={id}>
              {/* On phones the fix actions wrap onto their own line, under the reason. */}
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap"
                data-check={id}
              >
                <StateIcon state={state} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium">
                    {label}
                    {providerIds.has(id) ? (
                      <span className="text-3xs font-normal text-muted-foreground">provider</span>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "text-2xs",
                      needsAttention ? "break-words" : "truncate",
                      state === "missing" || state === "error"
                        ? "text-status-failed/90"
                        : "text-muted-foreground",
                    )}
                    title={c?.message}
                  >
                    {state === "checking" ? "Checking…" : c?.message}
                  </div>
                  {c && needsAttention && <CheckDetails check={c} />}
                </div>
                {c?.fix && needsAttention && (
                  <div className="flex min-w-0 basis-full items-center gap-1.5 pl-9 sm:basis-auto sm:pl-0">
                    <Button
                      size="xs"
                      variant="ghost"
                      className="min-w-0 max-w-56 shrink font-mono text-muted-foreground"
                      title={c.fix.command}
                      onClick={() => void copyWithFeedback(c.fix?.command ?? "", "Command copied")}
                    >
                      <Copy /> <span className="truncate">{c.fix.command}</span>
                    </Button>
                    <Button size="sm" onClick={() => setFixing(c)}>
                      {c.fix.kind === "login" ? (
                        <LogIn />
                      ) : c.fix.kind === "install" ? (
                        <Download />
                      ) : (
                        <Wrench />
                      )}
                      {fixLabel[c.fix.kind]}
                    </Button>
                  </div>
                )}
              </div>
              {id === "claude" && c?.installed && <ClaudeSupportRow />}
            </Fragment>
          );
        })}
      </div>
      <div className="mt-2 flex items-start gap-3">
        <p className="flex-1 text-2xs text-muted-foreground">
          CodeDen reuses your existing logins and never stores provider or GitHub credentials. At
          least one agent provider is required; GitHub is recommended.
        </p>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={rechecking}
          onClick={() => void recheck()}
        >
          <RefreshCw className={cn(rechecking && "animate-spin")} /> Re-check
        </Button>
      </div>
      <Dialog open={fixing !== null} onOpenChange={(o) => !o && closeFix()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {fixing?.fix ? fixLabel[fixing.fix.kind] : ""} · {fixing?.label}
            </DialogTitle>
            <DialogDescription>
              {fixing?.fix?.kind === "login"
                ? "Runs the tool's own login. Finish in your browser, then close this window."
                : "Runs the command in a terminal on this machine. Close this window when it's done."}
            </DialogDescription>
          </DialogHeader>
          <div className="h-64 overflow-hidden rounded-lg border border-border">
            {fixing && <TerminalView sessionId={null} command={fixing.fix?.command} ephemeral />}
          </div>
          <div className="flex items-center justify-between">
            {fixing?.fix?.url ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fixing.fix?.url && platform.openExternal(fixing.fix.url)}
              >
                Install guide
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={closeFix}>Done, re-check</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
