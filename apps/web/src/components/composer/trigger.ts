/** Composer `@` mention and `/` command detection. Pure, so it's easy to test. */

export interface Trigger {
  kind: "mention" | "command";
  /** Text typed after the trigger character. */
  query: string;
  /** Index of the trigger character in the text. */
  start: number;
}

/**
 * Find an active trigger ending at the caret:
 * - `@query` anywhere after whitespace or at the start;
 * - `/query` only at the very start of the message (commands and skills, including plugin
 *   ones such as `/plugin:command`).
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([\w./\\-]*)$/.exec(before);
  if (mention) {
    const query = mention[2] ?? "";
    return { kind: "mention", query, start: caret - query.length - 1 };
  }
  const command = /^\/([\w:.-]*)$/.exec(before);
  if (command) return { kind: "command", query: command[1] ?? "", start: 0 };
  return null;
}

/** Commands whose name contains `query`, those starting with it first, otherwise in order. */
export function rankCommands<T extends { name: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  const q = query.toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().includes(q));
  const starts = (c: T) => c.name.toLowerCase().startsWith(q);
  return [...matches.filter(starts), ...matches.filter((c) => !starts(c))];
}

/** Replace the trigger with `replacement` and return the new text and caret. */
export function applyTrigger(
  text: string,
  caret: number,
  trigger: Trigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement} ${text.slice(caret)}`;
  return { text: next, caret: trigger.start + replacement.length + 1 };
}
