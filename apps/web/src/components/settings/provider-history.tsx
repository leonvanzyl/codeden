import type { ProviderInfo } from "@codeden/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClient } from "@/lib/api";
import { ago } from "@/lib/format";
import { useSnapshotData } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings > Providers: for providers whose own apps list every conversation on the machine as
 * the user's (`capabilities.vendorHistory`), hide the ones CodeDen started before it kept them
 * out. The list comes from CodeDen's own record of its sessions, and nothing is hidden until the
 * user confirms it.
 */
export function ProviderHistorySettings() {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const withHistory = providers.filter((p) => p.capabilities.vendorHistory);
  if (withHistory.length === 0) return null;
  return (
    <SettingsSection
      title="Provider apps"
      description="Some providers' own apps list every conversation on this machine as yours. CodeDen keeps the sessions it starts out of those lists."
    >
      {withHistory.map((p) => (
        <HideHistoryRow key={p.id} provider={p} />
      ))}
    </SettingsSection>
  );
}

function HideHistoryRow({ provider }: { provider: ProviderInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingRow
      label={`Hide CodeDen's sessions from the ${provider.displayName} app`}
      help="New sessions are hidden when each turn ends. This hides the ones from before: only sessions CodeDen started, never your own. They are archived, not deleted, and CodeDen can still resume them."
    >
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <EyeOff /> Review
      </Button>
      {open && <HideHistoryDialog provider={provider} onClose={() => setOpen(false)} />}
    </SettingRow>
  );
}

function HideHistoryDialog({ provider, onClose }: { provider: ProviderInfo; onClose: () => void }) {
  const client = useClient();
  const app = `the ${provider.displayName} app`;
  const preview = useQuery({
    queryKey: ["provider-history", provider.id],
    queryFn: () => client.getProviderHistory(provider.id),
    gcTime: 0,
    retry: false,
  });
  const hide = useMutation({ mutationFn: () => client.hideProviderHistory(provider.id) });
  const entries = preview.data?.entries ?? [];
  const done = hide.data;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="hide-provider-history">
        <DialogHeader>
          <DialogTitle>Hide CodeDen's sessions from {app}</DialogTitle>
          <DialogDescription>
            Only sessions CodeDen started, found by its own record of them. They are archived in{" "}
            {app}, not deleted.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-1 text-[13px]" data-testid="hide-provider-history-result">
            <p>
              Hid {plural(done.hidden.length, "session")} from {app}.
            </p>
            {done.missing.length > 0 && (
              <p className="text-2xs text-muted-foreground">
                {plural(done.missing.length, "session")} had already gone from it.
              </p>
            )}
            {done.failed.length > 0 && (
              <p className="text-2xs text-status-failed">
                {plural(done.failed.length, "session")} couldn't be hidden:{" "}
                {done.failed[0]?.message}
              </p>
            )}
          </div>
        ) : preview.isPending ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Looking for CodeDen's sessions in {app}...
          </p>
        ) : preview.isError ? (
          <p className="text-[13px] text-status-failed">{preview.error.message}</p>
        ) : entries.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            None of CodeDen's sessions are listed in {app}.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[13px]">
              {plural(entries.length, "session")} CodeDen started{" "}
              {entries.length === 1 ? "is" : "are"} listed in {app}:
            </p>
            <ul
              className="max-h-72 overflow-y-auto rounded-lg border border-border"
              data-testid="hide-provider-history-list"
            >
              {entries.map((e) => (
                <li key={e.resumeToken} className="border-b border-border px-3 py-2 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-medium">
                      {e.sessionTitle ?? (e.preview || e.resumeToken)}
                    </span>
                    {e.updatedAt && (
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        {ago(e.updatedAt)}
                      </span>
                    )}
                  </div>
                  {e.sessionTitle && e.preview && (
                    <p className="truncate text-2xs text-muted-foreground">{e.preview}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {hide.isError && <p className="text-2xs text-status-failed">{hide.error.message}</p>}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              size="sm"
              disabled={entries.length === 0 || hide.isPending}
              onClick={() => hide.mutate()}
            >
              {hide.isPending && <Loader2 className="animate-spin" />}
              Hide {plural(entries.length, "session")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
