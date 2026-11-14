import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw } from "lucide-react";
import { canUpdate } from "@/components/shell/update-banner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { updatesKey, useUpdateActions, useUpdates } from "@/lib/updates";

/**
 * About (§16): the running version against the latest on npm with "Check now" and "Update
 * now", the side-by-side installed versions, and "Roll back to the previous version".
 */
export function UpdateCheck() {
  const client = useClient();
  const queryClient = useQueryClient();
  const { data } = useUpdates();
  const actions = useUpdateActions();
  const refresh = useMutation({
    mutationFn: () => client.getUpdates({ refresh: true }),
    onSuccess: (status) => queryClient.setQueryData(updatesKey, status),
  });
  if (!data) return null;
  const busy = data.state === "installing" || data.state === "restarting";
  let text: string;
  if (!data.enabled) text = "Update checks are off (Settings > General).";
  else if (data.state === "installing") text = `Installing ${data.target}...`;
  else if (data.state === "restarting") text = `Restarting into ${data.target}...`;
  else if (data.state === "installed") text = `Version ${data.target} is installed.`;
  else if (data.updateAvailable) text = `Version ${data.latest} is available.`;
  else if (data.error) text = `Couldn't check for updates: ${data.error}`;
  else if (data.latest) text = "You're on the latest version.";
  else text = "Not checked yet.";
  const rollbackLabel = data.rollbackTo
    ? `Roll back to ${data.rollbackTo}`
    : "Roll back to the previous version";
  const showInstall = data.updateAvailable && canUpdate(data) && data.state === "idle";

  return (
    <div className="mt-2 space-y-1.5 text-2xs" data-testid="update-check">
      <div className="flex flex-wrap items-center gap-2">
        <span className={data.updateAvailable ? "text-status-waiting" : "text-muted-foreground"}>
          {text}
        </span>
        {/* One group, so on a narrow card the buttons wrap together under the text. */}
        {(showInstall || data.enabled) && (
          <div className="flex flex-wrap items-center gap-2">
            {showInstall && (
              <Button size="xs" onClick={() => actions.install.mutate()} disabled={busy}>
                Update now
              </Button>
            )}
            {data.enabled && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
              >
                <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} /> Check now
              </Button>
            )}
          </div>
        )}
      </div>
      {data.source === "source" ? (
        <p className="text-muted-foreground">
          You're running from source: pull and rebuild to update (
          <code className="font-mono">git pull && pnpm install && pnpm build</code>).
        </p>
      ) : (
        data.installed.length > 0 && (
          <p className="text-muted-foreground" data-testid="installed-versions">
            Installed:{" "}
            {data.installed
              .map(
                (v) => `${v.version}${v.current ? " (current)" : ""}${v.valid ? "" : " (broken)"}`,
              )
              .join(", ")}
          </p>
        )
      )}
      {data.state === "failed" && data.installError && (
        <p className="text-status-failed">Last update failed: {data.installError}</p>
      )}
      {data.warning && <p className="text-status-failed">{data.warning}</p>}
      {data.canRollback && (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || actions.rollback.isPending}
          onClick={() => actions.rollback.mutate()}
        >
          <RotateCcw /> {rollbackLabel}
        </Button>
      )}
      {actions.rollback.error && (
        <p className="text-status-failed">{actions.rollback.error.message}</p>
      )}
    </div>
  );
}
