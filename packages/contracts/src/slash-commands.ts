import { z } from "zod";
import { ProviderId } from "./common";

/**
 * `/` commands and skills offered by the composer (§13). The server lists them per session from
 * the skills and custom commands that apply to its working folder, plus whatever the provider
 * itself reports (its built-in commands, plugin commands).
 */

/** Longest description kept for a `/` entry; the composer shows one line. */
export const SLASH_DESCRIPTION_MAX = 200;

/** The first line of `text`, cut to `max` characters (with an ellipsis when cut). */
export function oneLineDescription(text: string, max = SLASH_DESCRIPTION_MAX): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * One command as a provider reports it for a live session (`session.updated.commands`):
 * built-in commands and everything else it would run for `/<name>`.
 */
export const ProviderCommand = z.object({
  /** Name without the leading slash, e.g. `compact`. */
  name: z.string().min(1),
  /** One line about what it does; empty when the provider gives none. */
  description: z.string(),
  /** Hint for the arguments it takes, e.g. `<file>`. */
  argumentHint: z.string().optional(),
  /** True for the provider's own commands (absent for user, project and plugin ones). */
  builtin: z.boolean().optional(),
});
export type ProviderCommand = z.infer<typeof ProviderCommand>;

/** A command the agent runs, or a skill it loads. */
export const SlashCommandKind = z.enum(["command", "skill"]);
export type SlashCommandKind = z.infer<typeof SlashCommandKind>;

/** One entry of the composer's `/` menu. Picking it inserts `/<name> `. */
export const SlashCommand = z.object({
  /** Name without the leading slash, as typed after `/`. */
  name: z.string().min(1),
  /** One line about what it does; empty when there is none. */
  description: z.string(),
  kind: SlashCommandKind,
  /** The provider whose configuration defines it. */
  provider: ProviderId.optional(),
  /** Hint for the arguments it takes, e.g. `[issue-number]`. */
  argumentHint: z.string().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

/** `GET /api/sessions/:id/commands`: the session's commands and skills, sorted by name. */
export const SlashCommandList = z.array(SlashCommand);
export type SlashCommandList = z.infer<typeof SlashCommandList>;
