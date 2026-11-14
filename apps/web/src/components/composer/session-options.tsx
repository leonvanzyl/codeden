import type { Session, Snapshot, UpdateSessionRequest } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { AUTONOMY, supportsReadOnly } from "@/components/thread/autonomy";
import { useClient } from "@/lib/api";
import { snapshotKey, useSnapshotData } from "@/lib/queries";
import { useHandoffBlocked } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";
import { ModelPicker } from "./model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "./pickers";

function changeSummary(patch: UpdateSessionRequest): string {
  if (patch.planMode !== undefined) return patch.planMode ? "Plan mode on" : "Plan mode off";
  if (patch.autonomy !== undefined) return `Permissions: ${AUTONOMY[patch.autonomy].label}`;
  if (patch.model !== undefined && patch.effort !== undefined) return "Model and effort changed";
  return patch.model !== undefined ? "Model changed" : "Effort changed";
}

/**
 * When a change made during a running turn takes effect. Model and effort always wait for the
 * next turn; autonomy and plan mode reach the running turn from its next tool call when the
 * provider reports `liveAutonomy`.
 */
export function appliesFrom(
  patch: UpdateSessionRequest,
  running: boolean,
  liveAutonomy: boolean,
): string | undefined {
  if (!running) return undefined;
  const live = patch.autonomy !== undefined || patch.planMode !== undefined;
  if (live && liveAutonomy) return "Applies from the next tool call.";
  return "Applies from the next turn.";
}

/**
 * Model, effort, autonomy and plan mode for a session: a change is saved with
 * `PATCH /api/sessions/:id`. Model and effort apply from the next turn (a running turn keeps
 * its settings); autonomy and plan mode apply from the next tool call or the next turn, as the
 * provider allows. The provider is fixed for the life of a session, so the picker shows the
 * other providers locked; in an agent session they offer to hand the work off to a new session
 * on that provider (§9). The pickers show the server's values, never a local-only choice.
 */
export function SessionOptions({ session, running }: { session: Session; running: boolean }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const providerInfo = providers.find((p) => p.id === session.provider);
  const liveAutonomy = providerInfo?.capabilities.liveAutonomy ?? false;
  const setHandoff = useUiStore((s) => s.setHandoff);
  const handoffBlocked = useHandoffBlocked(session);
  const update = useMutation({
    mutationFn: (patch: UpdateSessionRequest) => client.updateSession(session.id, patch),
    onSuccess: (updated, patch) => {
      queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
        s ? { ...s, sessions: s.sessions.map((x) => (x.id === updated.id ? updated : x)) } : s,
      );
      toast.success(changeSummary(patch), {
        id: `session-options-${session.id}`,
        description: appliesFrom(patch, running, liveAutonomy),
      });
    },
    onError: (e) => toast.error("Couldn't change the session", { description: e.message }),
  });
  // Changes go out one at a time, so a model pick and an effort pick land in order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (patch: UpdateSessionRequest) => {
    queue.current = queue.current.then(() => update.mutateAsync(patch)).catch(() => {});
  };

  return (
    <>
      <ModelPicker
        providers={providers}
        lockedProvider={session.provider}
        handoff={
          session.role === "agent"
            ? {
                blocked: handoffBlocked,
                onHandoff: (provider) => setHandoff({ sessionId: session.id, provider }),
              }
            : undefined
        }
        value={{ provider: session.provider, model: session.model, effort: session.effort }}
        shortcut
        onChange={(next) => {
          const patch: UpdateSessionRequest = {};
          if (next.model !== session.model) patch.model = next.model;
          if (next.effort !== session.effort) patch.effort = next.effort;
          if (patch.model !== undefined || patch.effort !== undefined) save(patch);
        }}
      />
      {session.role === "agent" && (
        <AutonomyPicker
          value={session.autonomy}
          readOnlySupported={supportsReadOnly(providerInfo)}
          onChange={(autonomy) => {
            if (autonomy !== session.autonomy) save({ autonomy });
          }}
        />
      )}
      {session.role === "agent" && providerInfo?.capabilities.planMode && (
        <PlanToggle value={session.planMode ?? false} onChange={(planMode) => save({ planMode })} />
      )}
    </>
  );
}
