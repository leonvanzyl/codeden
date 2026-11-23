import { SHELL_DRIVES } from "./paths";

/**
 * PowerShell's variable syntax for an item on a drive (#547): `${C:\Users\me\.ssh\id_rsa}` reads
 * the file, as a value or inside a double-quoted string, and `${C:\Users\me\.bashrc} = 'x'`
 * (or `+=`) writes it. The lexer (`./shell`) notes them as the command's reads and writes, so the
 * secrets check and the outside-the-worktree check judge the file like any other.
 */

/** Scope modifiers (`${global:count}`, `${script:x}`): a variable, not a drive. */
const SCOPES = new Set(["global", "local", "script", "private", "using", "workflow"]);

/**
 * The item a braced variable stands for, from what is between its `${` and `}` as written
 * (a backtick escapes the next character: `` ${a`}b} `` names `a}b`): the name when it is on a
 * drive (`C:\x`, `c:x`, `Temp:\x`, a PSDrive of any name), or undefined for a plain variable
 * (`${my var}`), a scope (`${global:x}`) or the shell's own `Env:`, `Variable:`, `Function:` and
 * `Alias:` drives. `auto`: the shell is unknown, so bash's `${x:-default}`, `${x:=v}`, `${x:?msg}`,
 * `${x:+alt}` and `${x:1}` (a colon then an operator, a digit or a space) are not drive items.
 */
export function variableItem(written: string, auto = false): string | undefined {
  const name = written.replace(/`([\s\S])/g, "$1");
  const drive = /^([a-z][\w-]*):/i.exec(name)?.[1]?.toLowerCase();
  if (!drive || SCOPES.has(drive) || SHELL_DRIVES.has(drive)) return undefined;
  if (auto && /^[^:]*:(?:[-=?+\d\s]|$)/.test(name)) return undefined;
  return name;
}

/**
 * An assignment operator after an assignment target (`=`, `+=`, `-=`, `*=`, `/=`, `%=`, `??=`),
 * spaces before it allowed; not a comparison (`==`).
 */
const ASSIGNS = /[ \t]*(?:[-+*/%]|\?\?)?=(?!=)/y;

/** True when `src` has an assignment operator at `at` (right after a variable). */
export function assignsAt(src: string, at: number): boolean {
  ASSIGNS.lastIndex = at;
  return ASSIGNS.test(src);
}

/** Braced variables in an expandable text, such as a `@"…"@` here-string's body. */
const BRACED = /(`?)\$\{((?:[^}`]|`[\s\S])*)\}/g;

/**
 * The items the braced variables in an expandable text (`@"…"@`) stand for, read when the text is
 * expanded. A backtick before the `$` makes it literal. `auto`: the shell is unknown
 * (`variableItem`).
 */
export function itemsIn(text: string, auto = false): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BRACED)) {
    if (m[1]) continue;
    const item = variableItem(m[2] as string, auto);
    if (item !== undefined) out.push(item);
  }
  return out;
}
