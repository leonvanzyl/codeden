import type { ModelInfo, ReasoningEffort } from "@codeden/contracts";
import { ReasoningEffort as ReasoningEffortSchema } from "@codeden/contracts";
import { DEFAULT_MODEL_ID } from "../util/model";
import { modelId } from "./config";
import type { OcModel, OcProvider } from "./protocol";

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

/** Efforts of a model in a list, by CodeDen id. */
export function modelEfforts(
  list: readonly ModelInfo[],
  id: string | undefined,
): readonly ReasoningEffort[] | undefined {
  return id ? list.find((m) => m.id === id)?.efforts : undefined;
}
