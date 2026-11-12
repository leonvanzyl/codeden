import type { ModelInfo, ReasoningEffort } from "@codeden/contracts";
import { ReasoningEffort as ReasoningEffortSchema } from "@codeden/contracts";
import { DEFAULT_MODEL_ID } from "../util/model";
import { modelId } from "./config";
import type { OcModel, OcModelRef, OcProvider } from "./protocol";

const CONFIGURED_MODEL =
  "The model configured in OpenCode (opencode.json), or OpenCode's own default";

/**
 * Until OpenCode has listed its models, one entry that leaves the choice to the user's
 * OpenCode config. `note` says why the real list is missing when discovery failed.
 */
export function fallbackOpenCodeModels(note?: string): ModelInfo[] {
  return [
    {
      id: DEFAULT_MODEL_ID,
      label: "Default",
      description: note ? `${CONFIGURED_MODEL}. ${note}` : CONFIGURED_MODEL,
      efforts: [],
      isDefault: true,
    },
  ];
}

/** OpenCode variants that are CodeDen efforts, in CodeDen's order (`none`/`thinking` drop). */
export function effortsOf(m: Pick<OcModel, "variants">): ReasoningEffort[] {
  const ids = new Set((m.variants ?? []).map((v) => v.id));
  return ReasoningEffortSchema.options.filter((e) => ids.has(e));
}

/** True for models a coding session can use: enabled, not deprecated, with tool calling. */
export function isUsableModel(m: OcModel): boolean {
  return (
    m.enabled !== false && m.status !== "deprecated" && m.capabilities?.tools !== false && !!m.id
  );
}

/**
 * Map an OpenCode model to CodeDen's `ModelInfo`. The id is `<providerID>/<modelID>`, the form
 * OpenCode itself uses on its command line; the description names the provider, since one
 * OpenCode install can serve the same model through several providers.
 */
export function modelInfoFromOpenCode(
  m: OcModel,
  providerName?: string,
  isDefault = false,
): ModelInfo {
  const context = m.limit?.context;
  return {
    id: modelId(m),
    label: m.name || m.id,
    description: providerName || m.providerID,
    efforts: effortsOf(m),
    ...(isDefault ? { isDefault: true } : {}),
    ...(context && Number.isInteger(context) && context > 0 ? { contextWindow: context } : {}),
  };
}

/**
 * The usable models as `ModelInfo`, the default first, then grouped by provider in OpenCode's
 * order. Duplicate ids keep their first entry.
 */
export function openCodeModelList(
  models: readonly OcModel[],
  providers: readonly OcProvider[],
  defaultModel?: Pick<OcModel, "id" | "providerID"> | null,
): ModelInfo[] {
  const names = new Map(providers.map((p) => [p.id, p.name ?? p.id]));
  const defaultId = defaultModel ? modelId(defaultModel) : undefined;
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of models) {
    if (!isUsableModel(m)) continue;
    const id = modelId(m);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(modelInfoFromOpenCode(m, names.get(m.providerID), id === defaultId));
  }
  const providerOrder = [...new Set(out.map((m) => m.id.split("/")[0]))];
  return out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return providerOrder.indexOf(a.id.split("/")[0]) - providerOrder.indexOf(b.id.split("/")[0]);
  });
}

/**
 * A model's base price: input + output USD per million tokens of its entry without a context
 * tier. A model priced only above some context size counts as unpriced.
 */
function basePrice(m: OcModel): number | undefined {
  const cost = m.cost?.find((c) => !c.tier);
  const input = cost?.input;
  const output = cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const price = input + output;
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

/**
 * The utility model on OpenCode when Settings name none (§7.4): the cheapest model from the
 * provider of OpenCode's default model, by listed input + output price per million tokens
 * (base price). Staying on that provider keeps side jobs on the account and data policy the
 * user already chose (Sonnet's provider gives Haiku, never another provider's free tier).
 * A free model is only picked when the default is free too: a provider that sells models
 * may offer free ones on different data terms. Disabled, deprecated and unpriced models are
 * skipped (the default too), and the default wins ties. Undefined when nothing qualifies (no
 * default, no prices): OpenCode then uses its own default.
 */
export function cheapUtilityModel(
  models: readonly OcModel[],
  defaultModel: OcModel | null | undefined,
): OcModelRef | undefined {
  if (!defaultModel?.providerID || !defaultModel.id) return undefined;
  const candidates = [defaultModel, ...models].filter(
    (m) =>
      m.providerID === defaultModel.providerID &&
      !!m.id &&
      m.enabled !== false &&
      m.status !== "deprecated",
  );
  const paidDefault = (basePrice(defaultModel) ?? 0) > 0;
  let best: { model: OcModel; price: number } | undefined;
  for (const model of candidates) {
    const price = basePrice(model);
    if (price === undefined || (paidDefault && price === 0)) continue;
    if (!best || price < best.price) best = { model, price };
  }
  return best ? { providerID: best.model.providerID, id: best.model.id } : undefined;
}

/** Efforts of a model in a list, by CodeDen id. */
export function modelEfforts(
  list: readonly ModelInfo[],
  id: string | undefined,
): readonly ReasoningEffort[] | undefined {
  return id ? list.find((m) => m.id === id)?.efforts : undefined;
}
