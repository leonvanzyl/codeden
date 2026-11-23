import type { Project } from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
import { untilText } from "../../../services/factory/availability";
import type { ProviderChoice } from "../../../services/factory/sessions";
import { projectDefaultProvider } from "../../../services/projects/project-config";
import { autoOrder } from "../../../services/sessions/provider-order";
import { ToolError } from "../../define";

/** How a provider reads in text: "`gemini` (Gemini CLI)", or "`fake`" when the name is the id. */
const labelOf = (c: Pick<ProviderChoice, "id" | "name">) =>
  c.name === c.id ? `\`${c.id}\`` : `\`${c.id}\` (${c.name})`;

/** Its state: "ready", "not checked yet", or why not: "not installed, fix: `npm i …`". */
function stateOf(c: ProviderChoice): string {
  if (c.runnable) return c.checked ? "ready" : "not checked yet";
  const fix = c.fix ? `, fix: \`${c.fix.command}\`` : "";
  return `${c.reason}${untilText(c.until)}${fix}`;
}

/** The loaded providers and their states: "`fake`: ready; `gemini` (Gemini CLI): not installed". */
export function providerChoicesList(choices: ProviderChoice[]): string {
  return choices.map((c) => `${labelOf(c)}: ${stateOf(c)}`).join("; ");
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
  return `Provider id. ${omitted} Loaded providers when this list was made: ${providerChoicesList(choices)}. ${rules} The states are from the last check and may have changed since.`;
}

/** `describeInput` for a tool with a provider parameter named `param` (see `providerChoicesText`). */
export function describeProviderParam(param: string, omitted: string, rules: string) {
  return async (services: AppServices): Promise<Record<string, string>> => ({
    [param]: providerChoicesText(await services.factory.providerChoices(), omitted, rules),
  });
}

/**
 * Refuse a provider id the runner hasn't loaded, naming the loaded ones and their states. Not
 * checked while the runner reports no providers (not connected): nothing to check against.
 */
export async function assertProviderLoaded(
  services: AppServices,
  id: string | null | undefined,
): Promise<void> {
  if (!id) return;
  const choices = await services.factory.providerChoices();
  if (choices.length === 0 || choices.some((c) => c.id === id)) return;
  throw new ToolError(
    `Provider ${id} is not available. Loaded providers: ${providerChoicesList(choices)}.`,
  );
}

/**
 * The provider a PM's `start_session` starts on when it names none: the project's default, else
 * the default for agents in Settings (`auto`: the first ready one in the order `auto` tries
 * them), each only when the runner loaded it and it is ready. Undefined while the runner reports
 * no providers (not connected): the session service picks, as it does for any start. Refused,
 * with the loaded providers and their states, when none of those is ready.
 */
export async function fallbackProvider(
  services: AppServices,
  project: Pick<Project, "defaultProvider" | "path">,
): Promise<string | undefined> {
  const choices = await services.factory.providerChoices();
  if (choices.length === 0) return undefined;
  const byId = new Map(choices.map((c) => [c.id, c]));
  const projectDefault = projectDefaultProvider(project);
  const roleDefault = services.settings.get().providers.agent.provider;
  const candidates = [
    projectDefault,
    ...(roleDefault === "auto" ? autoOrder(choices.map((c) => c.id)) : [roleDefault]),
  ];
  const ready = candidates.find((id) => id && byId.get(id)?.runnable);
  if (ready) return ready;

  const state = (id: string) => {
    const c = byId.get(id);
    return c ? `${labelOf(c)}, is ${stateOf(c)}` : `\`${id}\`, isn't loaded`;
  };
  const tried = [
    ...(projectDefault ? [`the project's default provider, ${state(projectDefault)}`] : []),
    ...(roleDefault === "auto"
      ? ["the default for agents in Settings is auto and no loaded provider is ready"]
      : roleDefault === projectDefault
        ? []
        : [`the default provider for agents in Settings, ${state(roleDefault)}`]),
  ];
  throw new ToolError(
    `No provider is ready for this session: ${tried.join("; ")}. Name a ready one in provider. Loaded providers: ${providerChoicesList(choices)}.`,
  );
}
