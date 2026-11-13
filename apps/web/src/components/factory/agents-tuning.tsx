import type { FactoryTuning, ProviderInfo, ReviewerFallback } from "@codeden/contracts";
import { useId } from "react";
import { Field } from "@/components/automations/form-bits";
import { useSnapshotData } from "@/lib/queries";

/** The agent knobs of the factory's tuning: who builds and who reviews, on which model. */
export type AgentsDraft = Pick<
  FactoryTuning,
  "builderProvider" | "builderModel" | "reviewerProvider" | "reviewerModel" | "reviewerFallback"
>;

const FALLBACKS: Array<{ id: ReviewerFallback; label: string }> = [
  { id: "builder", label: "Review on the builder's provider and model" },
  { id: "any", label: "Review on any available provider" },
  { id: "wait", label: "Wait until it is available again" },
];

const SELECT =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] disabled:opacity-60";

/**
 * Builder and reviewer provider and model (§10.1), from the runner's provider list. `Automatic`
 * keeps the defaults: builders on the project's provider, reviewers on a different provider from
 * the builder's. A model applies only to a chosen provider.
 */
export function AgentsTuning({
  value,
  onChange,
}: {
  value: AgentsDraft;
  onChange: (next: AgentsDraft) => void;
}) {
  const id = useId();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="agents-tuning">
      <div>
        <p className="text-[13px] font-medium">Agents</p>
        <p className="text-3xs text-muted-foreground">
          A reviewer on a different provider from the builder gives the most independent review.
          Providers that aren't signed in or are at their usage limit are skipped.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ProviderSelect
          id={`${id}-bp`}
          label="Builder provider"
          providers={providers}
          value={value.builderProvider}
          onChange={(builderProvider) =>
            onChange({ ...value, builderProvider, builderModel: null })
          }
        />
        <ModelSelect
          id={`${id}-bm`}
          label="Builder model"
          provider={providers.find((p) => p.id === value.builderProvider)}
          value={value.builderModel}
          onChange={(builderModel) => onChange({ ...value, builderModel })}
        />
        <ProviderSelect
          id={`${id}-rp`}
          label="Reviewer provider"
          providers={providers}
          value={value.reviewerProvider}
          autoLabel="Automatic (a different provider from the builder)"
          onChange={(reviewerProvider) =>
            onChange({ ...value, reviewerProvider, reviewerModel: null })
          }
        />
        <ModelSelect
          id={`${id}-rm`}
          label="Reviewer model"
          provider={providers.find((p) => p.id === value.reviewerProvider)}
          value={value.reviewerModel}
          onChange={(reviewerModel) => onChange({ ...value, reviewerModel })}
        />
      </div>
      <Field
        label="When the reviewer's provider is unavailable"
        htmlFor={`${id}-fb`}
        hint="Unavailable means not installed, not signed in, at its usage limit, or failing to start. With no provider available at all, the review waits."
      >
        <select
          id={`${id}-fb`}
          className={SELECT}
          value={value.reviewerFallback}
          onChange={(e) =>
            onChange({ ...value, reviewerFallback: e.target.value as ReviewerFallback })
          }
        >
          {FALLBACKS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function ProviderSelect({
  id,
  label,
  providers,
  value,
  autoLabel = "Automatic",
  onChange,
}: {
  id: string;
  label: string;
  providers: ProviderInfo[];
  value: string;
  autoLabel?: string;
  onChange: (provider: string) => void;
}) {
  const known = value === "auto" || providers.some((p) => p.id === value);
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">{autoLabel}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
        {!known && <option value={value}>{value} (not connected)</option>}
      </select>
    </Field>
  );
}

function ModelSelect({
  id,
  label,
  provider,
  value,
  onChange,
}: {
  id: string;
  label: string;
  provider: ProviderInfo | undefined;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  const models = provider?.models ?? [];
  const known = value === null || models.some((m) => m.id === value);
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        className={SELECT}
        value={value ?? ""}
        disabled={!provider}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{provider ? "Provider default" : "Choose a provider first"}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {!known && value && <option value={value}>{value}</option>}
      </select>
    </Field>
  );
}
