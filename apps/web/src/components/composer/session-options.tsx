import type { Session, Snapshot, UpdateSessionRequest } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { toast } from "sonner";
import { AUTONOMY, supportsReadOnly } from "@/components/thread/autonomy";
import { useClient } from "@/lib/api";
import { snapshotKey, useSnapshotData } from "@/lib/queries";
import { NOT_A_REPO_ACTION_REASON, useHandoffBlocked } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";
import { ChecksToggle } from "./checks-toggle";
import { PickerFooterAction } from "./model-picker/footer";
import { roleSwitchHint } from "./model-picker/logic";
import { ModelPicker } from "./model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "./pickers";

function changeSummary(patch: UpdateSessionRequest): string {
  if (patch.planMode !== undefined) return patch.planMode ? "Plan mode on" : "Plan mode off";
  if (patch.untilChecksPass === false) return "Keep going until checks pass: off";
  if (patch.untilChecksPass !== undefined || patch.checkRounds !== undefined) {
    return `Keep going until checks pass${patch.checkRounds ? `, up to ${patch.checkRounds} ${patch.checkRounds === 1 ? "round" : "rounds"}` : ""}`;
  }
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
  if (patch.untilChecksPass !== undefined || patch.checkRounds !== undefined) {
    return "Applies when this turn ends.";
  }
  const live = patch.autonomy !== undefined || patch.planMode !== undefined;
  if (live && liveAutonomy) return "Applies from the next tool call.";
  return "Applies from the next turn.";
}

/**
 * Model, effort, autonomy, plan mode and the checks loop for a session: a change is saved with
 * `PATCH /api/sessions/:id`. Model and effort apply from the next turn (a running turn keeps
 * its settings); autonomy and plan mode apply from the next tool call or the next turn, as the
 * provider allows. The provider is fixed for the life of a session, so the picker shows the
 * other providers locked; in an agent session they offer to hand the work off to a new session
 * on that provider (§9), and in the orchestrator's or a PM's they point to the role's provider
 * setting (§8.1). The pickers show the server's values, never a local-only choice.
 */
export function SessionOptions({ session, running }: { session: Session; running: boolean }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
                // A folder that isn't a repository won't become one when a turn ends.
                lasting: handoffBlocked === NOT_A_REPO_ACTION_REASON,
                onHandoff: (provider) => setHandoff({ sessionId: session.id, provider }),
              }
            : undefined
        }
        // The orchestrator and PMs can't be handed off: their provider is the role's setting.
        switchHint={session.role === "agent" ? undefined : roleSwitchHint(session.role)}
        footer={
          session.role === "agent" || providers.length < 2
            ? undefined
            : (close) => (
                <PickerFooterAction
                  note={`${session.role === "orchestrator" ? "The orchestrator" : "Project managers"} can run on another provider.`}
                  action="Change provider"
                  onClick={() => {
                    close();
                    void navigate({ to: "/settings/$section", params: { section: "providers" } });
                  }}
                />
              )
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
      {session.role === "agent" && providerInfo && (
        <PlanToggle
          value={session.planMode ?? false}
          unavailable={
            providerInfo.capabilities.planMode
              ? undefined
              : { provider: providerInfo.displayName, wasOn: session.planMode ?? false }
          }
          onChange={(planMode) => save({ planMode })}
        />
      )}
      {session.role === "agent" &&
        session.checks &&
        session.checks.commands.length > 0 &&
        session.autonomy !== "read_only" && (
          <ChecksToggle
            checks={session.checks.commands}
            value={session.checks}
            onChange={(next) =>
              save({ untilChecksPass: next.untilPass, checkRounds: next.maxRounds })
            }
          />
        )}
    </>
  );
}
