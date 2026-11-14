import type { ModelInfo } from "@codeden/contracts";
import type { AcpModel } from "../acp/config";
import { DEFAULT_MODEL_ID } from "../util/model";

const CONFIGURED_MODEL = "The model selected in Gemini CLI (its own setting)";

/**
 * Gemini CLI's model aliases, which always point at its current models: listed until a session
 * reports the account's own list.
 */
const ALIASES: readonly ModelInfo[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Gemini CLI picks a Pro or Flash model for each task",
    efforts: [],
  },
  { id: "pro", label: "Pro", description: "Gemini CLI's current Pro model", efforts: [] },
  { id: "flash", label: "Flash", description: "Gemini CLI's current Flash model", efforts: [] },
  {
    id: "flash-lite",
    label: "Flash Lite",
    description: "Gemini CLI's current Flash Lite model",
    efforts: [],
  },
];

/** "Default" leaves the choice to Gemini CLI's own setting. */
function defaultModel(): ModelInfo {
  return {
    id: DEFAULT_MODEL_ID,
    label: "Default",
    description: CONFIGURED_MODEL,
    efforts: [],
    isDefault: true,
  };
}

/** Until a Gemini session has listed its models: Default, then Gemini CLI's aliases. */
export function fallbackGeminiModels(): ModelInfo[] {
  return [defaultModel(), ...ALIASES.map((m) => ({ ...m }))];
}

/**
 * The models a Gemini session reports (`models.availableModels`), after Default. Gemini CLI has
 * no reasoning-effort setting over ACP, so no model offers efforts.
 */
export function geminiModelInfos(models: readonly AcpModel[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel()];
  for (const m of models) {
    if (!m.id || m.id === DEFAULT_MODEL_ID || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      label: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
      efforts: [],
    });
  }
  return out;
}
