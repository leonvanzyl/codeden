import type { SimpleCommand } from "./shell";

/**
 * PowerShell assignments (§11.2, #545). The right-hand side of `$r = Remove-Item C:\x -Recurse` is
 * a command PowerShell runs, so the parser drops the assignment and leaves that command as if it
 * stood alone: every rule then judges it, each stage of its pipe included. A plain value
 * (`$a = 1`, `$s = "x"`) is left as a harmless word, as it would be alone.
 *
 * The left-hand side is one or more targets, each a variable (`$x`, `$script:x`, `${my var}`,
 * `$x[0]`, `$h.Key`) with optional type constraints before it (`[string]$x`, `[int] $x`), several
 * separated by commas (`$a, $b = …`); then `=` or a compound operator (`+=`, `-=`, `*=`, `/=`,
 * `%=`, `??=`). Spaces around the operator are optional (`$x=…`), and a chain (`$a = $b = …`) is
 * followed to its last value.
 */

/** A bracketed type or attribute, up to three levels deep: `[int]`, `[List[string[]]]`. */
const BRACKETS = String.raw`\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\]`;
/** A variable, with members or indexes: `$x`, `$env:PATH`, `${a b}`, `$x[0].Name`. */
const VARIABLE = String.raw`\$(?:\{[^}]*\}|[\w:]+|[$?^])(?:\.\$?\w+|${BRACKETS})*`;
const TARGET = String.raw`(?:${BRACKETS}\s*)*${VARIABLE}`;
/** `=`, `+=`, `-=`, `*=`, `/=`, `%=` or `??=`, but not a comparison (`==`). */
const OPERATOR = String.raw`(?:[-+*/%]|\?\?)?=(?!=)`;
/** One assignment's targets and operator, matched where the last one ended (sticky). */
const ASSIGNMENT = new RegExp(String.raw`${TARGET}(?:\s*,\s*${TARGET})*\s*${OPERATOR}\s*`, "y");

/**
 * Drop the assignments a command starts with, so its words are the command they assign, and mark
 * it `assigned`: what a variable keeps is still checked as paths (`keptWords`).
 */
export function dropAssignments(cmd: SimpleCommand): void {
  const text = cmd.words.join(" ");
  let end = 0;
  for (;;) {
    ASSIGNMENT.lastIndex = end;
    const match = ASSIGNMENT.exec(text);
    if (!match?.[0]) break;
    end += match[0].length;
  }
  if (end === 0) return;
  cmd.words = after(cmd, end);
  cmd.assigned = true;
}

/**
 * The words an assignment keeps in its variable, as the arguments of a command that runs nothing
 * (`$t = 'C:\…\install-token'` gives `= C:\…\install-token`); undefined when `cmd` assigns
 * nothing. A later command reads or writes them through the variable (`Get-Content $t`,
 * `Set-Content $p …`), so the classifier judges this command too, with every rule that reads
 * arguments as paths: secrets, CodeDen's own home and credentials, the agent CLIs' logins, agents'
 * allow-lists and CodeDen's project config. These are the words those rules saw before the
 * assignment was dropped, so an assignment never asks less than it did then.
 */
export function keptWords(cmd: SimpleCommand): SimpleCommand | undefined {
  if (!cmd.assigned || !cmd.words.length) return undefined;
  return { words: ["=", ...cmd.words], writes: [], nested: [], lists: cmd.lists };
}

/**
 * The words after the first `length` characters of the words joined with spaces. A word cut in
 * two (`$x=Remove-Item`) keeps its rest, and its list commas move with it.
 */
function after(cmd: SimpleCommand, length: number): string[] {
  let start = 0;
  for (const [i, word] of cmd.words.entries()) {
    const end = start + word.length;
    if (length <= start) return cmd.words.slice(i);
    if (length < end) {
      const rest = word.slice(length - start);
      const commas = cmd.lists?.get(word);
      if (commas && cmd.lists) {
        const moved = commas.map((at) => at - (length - start)).filter((at) => at >= 0);
        if (moved.length) cmd.lists.set(rest, moved);
      }
      return [rest, ...cmd.words.slice(i + 1)];
    }
    start = end + 1;
  }
  return [];
}
