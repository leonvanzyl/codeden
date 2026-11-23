import type { AppServices } from "../../../services/container";
import { untilText } from "../../../services/factory/availability";
import type { ProviderChoice } from "../../../services/factory/sessions";

/** One provider as a model reads it: "`gemini` (Gemini CLI): not installed, fix: `npm i …`". */
function choiceText(c: ProviderChoice): string {
  const label = c.name === c.id ? `\`${c.id}\`` : `\`${c.id}\` (${c.name})`;
  if (c.runnable) return `${label}: ${c.checked ? "ready" : "not checked yet"}`;
  const fix = c.fix ? `, fix: \`${c.fix.command}\`` : "";
  return `${label}: ${c.reason}${untilText(c.until)}${fix}`;
}

/**
 * The description of a provider parameter: the ids the runner offers and whether each can run
 * new work, so a PM picks one without starting sessions to find out. `omitted` says what leaving
 * the parameter out means for this tool, `rules` what the tool does with an id that isn't loaded
 * or isn't ready. The parameter stays a string: the list is from when the tools were listed, and
 * a provider that became ready since must not be refused.
 */
export function providerChoicesText(
  choices: ProviderChoice[],
  omitted: string,
  rules: string,
): string {
  if (choices.length === 0) {
    return `Provider id. ${omitted} No provider is loaded right now (the runner isn't connected), so the ids can't be listed.`;
  }
  return `Provider id. ${omitted} Loaded providers when this list was made: ${choices
    .map(choiceText)
    .join("; ")}. ${rules} The states are from the last check and may have changed since.`;
}

/** `describeInput` for a tool with a provider parameter named `param` (see `providerChoicesText`). */
export function describeProviderParam(param: string, omitted: string, rules: string) {
  return async (services: AppServices): Promise<Record<string, string>> => ({
    [param]: providerChoicesText(await services.factory.providerChoices(), omitted, rules),
  });
}
