import type { McpServerConfig } from "@codeden/contracts";
import type { AcpConfigOption, AcpConfigValue, AcpMcpServer, AcpSessionSetup } from "./protocol";

/**
 * CodeDen's MCP servers in ACP's shape. HTTP servers (CodeDen's own proxy among them) go only
 * to agents that report `mcpCapabilities.http`; the names of those left out are returned so
 * the session can say so.
 */
export function acpMcpServers(
  servers: readonly McpServerConfig[],
  http: boolean,
): { servers: AcpMcpServer[]; skipped: string[] } {
  const out: AcpMcpServer[] = [];
  const skipped: string[] = [];
  for (const server of servers) {
    if (server.transport === "http") {
      if (!http) {
        skipped.push(server.name);
        continue;
      }
      out.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
      });
      continue;
    }
    out.push({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
    });
  }
  return { servers: out, skipped };
}

/** A config option's id (`id` in protocol version 1, `configId` later). */
export function optionId(option: AcpConfigOption): string | undefined {
  const id = option.id ?? option.configId;
  return typeof id === "string" && id ? id : undefined;
}

/** A `select` option's values, groups flattened. */
export function optionValues(option: AcpConfigOption): AcpConfigValue[] {
  const out: AcpConfigValue[] = [];
  for (const entry of option.options ?? []) {
    if (entry && typeof (entry as AcpConfigValue).value === "string") {
      out.push(entry as AcpConfigValue);
      continue;
    }
    const nested = (entry as { options?: AcpConfigValue[] }).options;
    if (Array.isArray(nested)) {
      for (const v of nested) if (v && typeof v.value === "string") out.push(v);
    }
  }
  return out;
}

/** The config option of a category (`mode`, `model`), matched by category, then by id. */
export function findOption(
  options: readonly AcpConfigOption[] | null | undefined,
  category: string,
): AcpConfigOption | undefined {
  const list = options ?? [];
  return list.find((o) => o.category === category) ?? list.find((o) => optionId(o) === category);
}

/** A model the agent offers, as it reports it. */
export interface AcpModel {
  id: string;
  name?: string;
  description?: string;
}

/** The agent's models and the current one: its `model` config option, else its model list. */
export function modelsOf(
  setup: Pick<AcpSessionSetup, "configOptions" | "models">,
): { current?: string; models: AcpModel[] } | undefined {
  const option = findOption(setup.configOptions, "model");
  if (option) {
    const models = optionValues(option).map((v) => ({
      id: v.value,
      ...(v.name ? { name: v.name } : {}),
      ...(v.description ? { description: v.description } : {}),
    }));
    const current = typeof option.currentValue === "string" ? option.currentValue : undefined;
    return { ...(current ? { current } : {}), models };
  }
  const list = setup.models?.availableModels;
  if (!Array.isArray(list)) return undefined;
  const models = list
    .filter((m) => typeof m?.modelId === "string" && m.modelId)
    .map((m) => ({
      id: m.modelId,
      ...(m.name ? { name: m.name } : {}),
      ...(m.description ? { description: m.description } : {}),
    }));
  const current = setup.models?.currentModelId;
  return { ...(current ? { current } : {}), models };
}

/** The mode ids the agent offers: its `mode` config option, else its modes. */
export function modeIds(setup: Pick<AcpSessionSetup, "configOptions" | "modes">): string[] {
  const option = findOption(setup.configOptions, "mode");
  if (option) return optionValues(option).map((v) => v.value);
  return (setup.modes?.availableModes ?? []).map((m) => m.id).filter(Boolean);
}
