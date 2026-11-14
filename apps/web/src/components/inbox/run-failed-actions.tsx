import { type InboxItem, inboxAttempts } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { ArrowRightLeft, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  type Availability,
  lowerFirst,
  providerAvailability,
} from "@/components/composer/model-picker/logic";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { ApiRequestError } from "@/lib/api/http";
import { useSetupStatus, useSnapshotData } from "@/lib/queries";
import { useUiStore } from "@/stores/ui";

/** Why Retry would only fail again, from the session's provider's setup check; null when it can run. */
function retryBlocked(
  name: string,
  availability: Availability | null,
): { text: string; detail: string | null; command: string | null } | null {
  if (!availability || availability.ready) return null;
  return {
    text: `${name} is ${lowerFirst(availability.reason ?? "Not ready")}`,
    detail: availability.detail,
    command: availability.command,
  };
}

/**
 * A failed run's answer (§11.1): Retry runs its session again on its provider, unless that
 * provider can't run now (not installed, too old, signed out): then Retry is off, the line says
 * why and what fixes it, and the work can continue on another provider (hand-off). A retry that
 * fails says why ("Retry failed"), and the server counts it on the same item.
 */
export function RunFailedActions({
  item,
  busy,
  dismissButton,
}: {
  item: InboxItem;
  busy: boolean;
  dismissButton: React.ReactNode;
}) {
  const client = useClient();
  const session = useSnapshotData(
    (s) => s.sessions.find((x) => x.id === item.sessionId) ?? null,
    null,
  );
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const checks = useSetupStatus({ staleTime: 60_000 }).data?.checks;
  const name = providers.find((p) => p.id === session?.provider)?.displayName ?? session?.provider;
  const blocked = retryBlocked(
    name ?? "Its provider",
    session ? providerAvailability(session.provider, checks) : null,
  );
  const handOff = () =>
    session && useUiStore.getState().setHandoff({ sessionId: session.id, provider: null });
  const retry = useMutation({
    mutationFn: () => client.retryInbox(item.id),
    // Refused because the provider can't run (e.g. its usage limit, which the setup checks don't
    // know): the work can still continue elsewhere.
    onError: (e: Error) =>
      toast.error("Retry failed", {
        description: e.message,
        ...(e instanceof ApiRequestError && e.code === "provider_unavailable" && session
          ? { action: { label: "Continue on another provider", onClick: handOff } }
          : {}),
      }),
    onSuccess: () => toast.success("Retrying"),
  });
  const attempts = inboxAttempts(item);
  return (
    <>
      <Button
        size="sm"
        onClick={() => retry.mutate()}
        disabled={busy || retry.isPending || blocked !== null}
        title={blocked?.text}
      >
        <RotateCcw /> {retry.isPending ? "Retrying…" : "Retry"}
      </Button>
      {blocked && session && (
        <Button size="sm" variant="outline" onClick={handOff}>
          <ArrowRightLeft /> Continue on another provider
        </Button>
      )}
      {dismissButton}
      {attempts > 1 && (
        <span className="text-2xs text-muted-foreground">Failed {attempts} times</span>
      )}
      {blocked && (
        <p
          className="w-full text-2xs text-status-failed"
          data-testid="retry-blocked"
          title={blocked.detail ?? undefined}
        >
          Retry is off: {blocked.text}.
          {blocked.command && (
            <>
              {" "}
              Fix it with <code className="font-mono">{blocked.command}</code>.
            </>
          )}
        </p>
      )}
    </>
  );
}
