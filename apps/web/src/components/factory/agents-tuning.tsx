import type { FactoryTuning, ProviderInfo, ReviewerFallback, SetupCheck } from "@codeden/contracts";
import { type ReactNode, useId } from "react";
import { Field } from "@/components/automations/form-bits";
import {
  lowerFirst,
  providerAvailability,
  providerOptionLabel,
} from "@/components/composer/model-picker/logic";
import { useSetupStatus, useSnapshotData } from "@/lib/queries";

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

/** What a review does while its chosen provider can't run, by `reviewerFallback`. */
const REVIEWS_MEANWHILE: Record<ReviewerFallback, string> = {
  builder: "reviews run on the builder's provider and model",
  any: "reviews run on any available provider",
  wait: "reviews wait",
};

const SELECT =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] disabled:opacity-60";

/**
 * Builder and reviewer provider and model (§10.1), from the runner's provider list. `Automatic`
 * keeps the defaults: builders on the project's provider, reviewers on a different provider from
 * the builder's. A model applies only to a chosen provider. Providers that can't run (from the
 * setup checks) say why, and choosing one says what happens until it can.
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
  const checks = useSetupStatus({ staleTime: 60_000 }).data?.checks;
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
          checks={checks}
          value={value.builderProvider}
          meanwhile="builders start on another available provider"
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
          checks={checks}
          value={value.reviewerProvider}
          autoLabel="Automatic (a different provider from the builder)"
          meanwhile={REVIEWS_MEANWHILE[value.reviewerFallback]}
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
  checks,
  value,
  autoLabel = "Automatic",
  meanwhile,
  onChange,
}: {
  id: string;
  label: string;
  providers: ProviderInfo[];
  checks: readonly SetupCheck[] | undefined;
  value: string;
  autoLabel?: string;
  /** What happens while the chosen provider can't run, e.g. "reviews wait". */
  meanwhile: string;
  onChange: (provider: string) => void;
}) {
  const chosen = providers.find((p) => p.id === value);
  const availability = chosen ? providerAvailability(chosen.id, checks) : null;
  let help: ReactNode;
  if (chosen && availability && !availability.ready) {
    help = (
      <span className="text-status-waiting">
        {chosen.displayName}: {lowerFirst(availability.reason ?? "Not ready")}
        {availability.command && (
          <>
            {" "}
            (run <code className="rounded bg-muted px-1 font-mono">{availability.command}</code>)
          </>
        )}
        . Until it can run, {meanwhile}.
      </span>
    );
  }
  return (
    <Field label={label} htmlFor={id} help={help}>
      <select id={id} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">{autoLabel}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {providerOptionLabel(p.displayName, providerAvailability(p.id, checks))}
          </option>
        ))}
        {!chosen && value !== "auto" && <option value={value}>{value} (not connected)</option>}
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
