import type { ModelInfo } from "@codeden/contracts";
import type { AcpModel } from "../acp/config";
import { DEFAULT_MODEL_ID } from "../util/model";

const CONFIGURED_MODEL = "The model selected in Cursor's CLI (Cursor's own default)";

/**
 * Until Cursor has listed its models, one entry that leaves the choice to the CLI's own
 * setting. `note` says why the real list is missing when discovery failed.
 */
export function fallbackCursorModels(note?: string): ModelInfo[] {
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

/**
 * Cursor's models as CodeDen lists them: the CLI's default first ("Default" follows whatever
 * the user picked in Cursor), then each model the account can use. Effort levels are separate
 * model ids in Cursor's list, so no model offers efforts of its own.
 */
export function cursorModelInfos(models: readonly AcpModel[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = fallbackCursorModels();
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

/**
 * The model list the CLI prints (`agent --list-models`): one model per line as
 * `<id> - <name>`, the selected one marked `(current)` or `(default)`. Headings and blank
 * lines are skipped.
 */
export function parseModelList(text: string): { models: AcpModel[]; current?: string } {
  const models: AcpModel[] = [];
  let current: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const m = /^(?:[-*•]\s*)?([A-Za-z0-9][\w.:/-]*)\s+[-–—]\s+(.+?)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const marked = /\s*\((current|default|selected)\)\s*$/i;
    if (marked.test(m[2])) current = m[1];
    models.push({ id: m[1], name: m[2].replace(marked, "").trim() });
  }
  return { models, ...(current ? { current } : {}) };
}
