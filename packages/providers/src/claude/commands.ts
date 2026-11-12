import { oneLineDescription as oneLine, type ProviderCommand } from "@codeden/contracts";

/** A command as the Agent SDK reports it (`supportedCommands()`, `commands_changed`). */
interface SdkCommand {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  builtin?: unknown;
}

/**
 * Claude Code's `/` commands for the composer: everything the CLI would run for `/<name>`
 * (built-in commands, skills, plugin and custom commands), minus its internal `__` entries,
 * with one-line descriptions and one entry per name.
 */
export function toProviderCommands(commands: unknown): ProviderCommand[] {
  if (!Array.isArray(commands)) return [];
  const seen = new Set<string>();
  const out: ProviderCommand[] = [];
  for (const c of commands as SdkCommand[]) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name || name.startsWith("__") || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const hint = typeof c.argumentHint === "string" ? c.argumentHint.trim() : "";
    out.push({
      name,
      description: typeof c.description === "string" ? oneLine(c.description) : "",
      ...(hint ? { argumentHint: oneLine(hint, 80) } : {}),
      ...(c.builtin === true ? { builtin: true } : {}),
    });
  }
  return out;
}
