import type { AutomationAction, TriagePolicy } from "@codeden/contracts";
import { Bot, Filter, MessageSquare } from "lucide-react";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { useEnabledProviders } from "@/components/composer/model-picker/use-model-settings";
import { Switch } from "@/components/ui/switch";
import { useSnapshotData } from "@/lib/queries";
import { Segmented } from "./form-bits";

type SessionAction = Extract<AutomationAction, { type: "start_session" }>;

/** The provider a session action runs on: its own, else the agent default, else the first. */
export function useSessionProvider(action: SessionAction) {
  const providers = useEnabledProviders(
    useSnapshotData((s) => s.runner.providers, []),
    action.provider,
  );
  const fallback = useSnapshotData((s) => s.settings.providers.agent.provider, null);
  const known = (id: string | null | undefined) =>
    id && providers.some((p) => p.id === id) ? id : null;
  const providerId = action.provider ?? known(fallback) ?? providers[0]?.id ?? null;
  return { providers, provider: providers.find((p) => p.id === providerId) };
}

/** The unified provider, model and effort picker for the sessions a run starts. */
export function AgentPicker({
  action,
  onChange,
  disabled,
}: {
  action: SessionAction;
  onChange: (a: SessionAction) => void;
  disabled?: boolean;
}) {
  const { providers, provider } = useSessionProvider(action);
  const custom = Boolean(action.provider || action.model || action.effort);
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border px-1 py-0.5">
      {provider ? (
        <ModelPicker
          providers={providers}
          value={{
            provider: provider.id,
            model: action.model ?? null,
            effort: action.effort ?? null,
          }}
          disabled={disabled}
          onChange={(next) =>
            onChange({
              ...action,
              provider: next.provider,
              model: next.model ?? undefined,
              effort: next.effort ?? undefined,
            })
          }
        />
      ) : (
        <span className="px-2 text-xs text-muted-foreground">
          {action.provider ?? "Default provider"} (not connected)
        </span>
      )}
      {custom && !disabled && (
        <button
          type="button"
          className="ml-auto px-2 text-3xs text-muted-foreground hover:text-foreground"
          onClick={() =>
            onChange({ ...action, provider: undefined, model: undefined, effort: undefined })
          }
        >
          Use the default agent
        </button>
      )}
    </div>
  );
}

/** How triage applies its decision: comment, close rejected issues, start ready ones. */
export function TriagePolicyFields({
  policy,
  onChange,
  disabled,
}: {
  policy: Partial<TriagePolicy> | undefined;
  onChange: (p: Partial<TriagePolicy>) => void;
  disabled?: boolean;
}) {
  const rows: { key: "comment" | "closeRejected" | "autoStart"; label: string; on: boolean }[] = [
    {
      key: "comment",
      label: "Comment on the issue with the decision",
      on: policy?.comment ?? true,
    },
    {
      key: "closeRejected",
      label: "Close duplicates and out-of-scope issues",
      on: policy?.closeRejected ?? false,
    },
    {
      key: "autoStart",
      label: "Start a session for ready issues without asking",
      on: policy?.autoStart ?? false,
    },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2.5 text-xs">
          <Switch
            size="sm"
            checked={r.on}
            disabled={disabled}
            aria-label={r.label}
            onCheckedChange={(v) => onChange({ ...policy, [r.key]: v })}
          />
          {r.label}
        </div>
      ))}
      <p className="text-3xs text-muted-foreground">
        Without auto-start (and always in manual projects) ready issues become a "Should I take this
        on?" decision in your inbox.
      </p>
    </div>
  );
}

/** The text of an action: the prompt, the PM message or the extra triage guidance. */
export function actionText(action: AutomationAction): string {
  if (action.type === "start_session") return action.prompt;
  if (action.type === "message_pm") return action.message;
  return action.instructions ?? "";
}

/** The action with new text. */
export function withActionText(action: AutomationAction, text: string): AutomationAction {
  if (action.type === "start_session") return { ...action, prompt: text };
  if (action.type === "message_pm") return { ...action, message: text };
  return { ...action, instructions: text || undefined };
}

/** What a run does: start an agent session (default), message the PM, or triage the issue. */
export function ActionKindPicker({
  action,
  onChange,
  disabled,
}: {
  action: AutomationAction;
  onChange: (a: AutomationAction) => void;
  disabled?: boolean;
}) {
  const switchTo = (type: AutomationAction["type"]) => {
    if (type === action.type) return;
    const text = actionText(action);
    if (type === "start_session") onChange({ type, prompt: text });
    else if (type === "message_pm") onChange({ type, message: text });
    else onChange({ type, instructions: text || undefined });
  };
  return (
    <Segmented
      label="What it does"
      value={action.type}
      disabled={disabled}
      onChange={switchTo}
      options={[
        { id: "start_session", label: "Start an agent session", icon: <Bot /> },
        { id: "message_pm", label: "Message the PM", icon: <MessageSquare /> },
        { id: "triage", label: "Triage the issue", icon: <Filter /> },
      ]}
    />
  );
}
