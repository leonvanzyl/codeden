import {
  binName,
  isScriptBlock,
  joinScriptBlocks,
  scriptBlockWords,
  unwrap,
} from "./command-words";
import { listedPaths } from "./deletes";
import { type PathContext, providerPath } from "./paths";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * The items PowerShell's item cmdlets create or change (#533), for the outside-the-worktree check
 * (`classifyWrite`, §11.2): files and registry keys alike. `New-Item`, `Set-Item`, `Clear-Item`,
 * `Rename-Item`, `Clear-Content` and the `*-ItemProperty` cmdlets write the item at their path
 * (`-Path`, `-LiteralPath` or the first positional word); `Copy-ItemProperty` and
 * `Move-ItemProperty` write their destination too. With no path they work on the current location
 * (`Set-ItemProperty . …` after `cd HKCU:\Software\Foo`), or on what a pipe hands them
 * (`Get-Item HKCU:\Software\Foo | Set-ItemProperty …`). `New-Item -Name x` writes `x` in its path.
 *
 * A folder (`New-Item -ItemType Directory`, `mkdir`, `md`) follows `mkdir`'s rule and runs freely
 * on disk; on a PowerShell drive it is a registry key or the like, which asks.
 *
 * Parameters are read the way PowerShell binds them, so a value (`-Value C:\x.exe`, `-Name Run`)
 * is never taken for a path: every named parameter but a switch takes the next word, and a script
 * block (`-NewName { $_.Name + '.bak' }`) is one argument (#541). So `Get-ChildItem C:\Docs |
 * Rename-Item -NewName { … }` renames the items the pipe hands it, like `-NewName x.bak` does. A
 * script block given as the path (`-LiteralPath { $_.FullName }`) works on the piped items too, and
 * its words may name paths.
 */

interface ItemCmdlet {
  /** Positions of the positional words that name an item it writes; `all` for `mkdir a b`. */
  positions: readonly number[] | "all";
  /** Its named parameters that name an item it writes. */
  named: readonly string[];
  /** Works on the current location, or the piped items, when it names none. */
  here?: true;
  /** `New-Item`: `-Name x` is created in the path, and `-ItemType Directory` makes a folder. */
  creates?: true;
  /** Makes folders (`mkdir`, `md`). */
  folder?: true;
  /**
   * Its path is the source of a move (`Rename-Item .env notes.txt`), which hands the file's
   * content over under a new name: the path still counts as a read for the secrets check, as
   * `mv .env x` and `Move-Item .env x` do.
   */
  moves?: true;
}

const PATHS = ["path", "literalpath", "lp", "pspath"];
const AT_PATH: ItemCmdlet = { positions: [0], named: PATHS, here: true };
const NEW_ITEM: ItemCmdlet = { ...AT_PATH, creates: true };
const RENAME: ItemCmdlet = { ...AT_PATH, moves: true };
const COPY_PROPERTY: ItemCmdlet = { positions: [1], named: ["destination"] };
const MOVE_PROPERTY: ItemCmdlet = { positions: [0, 1], named: [...PATHS, "destination"] };
const MKDIR: ItemCmdlet = { positions: "all", named: PATHS, folder: true };

/** The cmdlets and their aliases. */
const CMDLETS: Record<string, ItemCmdlet> = {
  "new-item": NEW_ITEM,
  ni: NEW_ITEM,
  "set-item": AT_PATH,
  si: AT_PATH,
  "clear-item": AT_PATH,
  cli: AT_PATH,
  "rename-item": RENAME,
  rni: RENAME,
  ren: RENAME,
  "clear-content": AT_PATH,
  clc: AT_PATH,
  "new-itemproperty": AT_PATH,
  "set-itemproperty": AT_PATH,
  sp: AT_PATH,
  "clear-itemproperty": AT_PATH,
  clp: AT_PATH,
  "rename-itemproperty": AT_PATH,
  rnp: AT_PATH,
  "copy-itemproperty": COPY_PROPERTY,
  cpp: COPY_PROPERTY,
  "move-itemproperty": MOVE_PROPERTY,
  mp: MOVE_PROPERTY,
  mkdir: MKDIR,
  md: MKDIR,
};

/** Switch parameters (they take no value); a prefix of one counts, as PowerShell allows. */
export const SWITCHES = [
  "force",
  "passthru",
  "whatif",
  "confirm",
  "usetransaction",
  "verbose",
  "debug",
];
/** A PowerShell parameter (`-Path`, `-Path:x`); not a negative number or a lone `-`. */
export const PARAM = /^-([a-z][\w-]*)(?::(.*))?$/is;

/**
 * What an item cmdlet writes: the paths to judge, and the words naming them that read nothing (a
 * secrets file it only writes, `New-Item .env`, is not a secrets access; one it moves is).
 */
export interface ItemWrites {
  targets: string[];
  words: string[];
}

const NONE: ItemWrites = { targets: [], words: [] };

/** The items `cmd` writes when it is an item cmdlet; `source`: the head of the pipe it reads. */
export function itemWrites(
  cmd: SimpleCommand,
  ctx: PathContext,
  source?: SimpleCommand,
): ItemWrites {
  const { tokens } = unwrap(cmd.words);
  const cmdlet = CMDLETS[binName(tokens[0])];
  if (!cmdlet) return NONE;
  const { named, positional } = readParams(joinScriptBlocks(tokens.slice(1)));
  const at =
    cmdlet.positions === "all" ? positional : cmdlet.positions.flatMap((k) => positional[k] ?? []);
  const words = [...at, ...cmdlet.named.flatMap((name) => valuesOf(named, name))];
  let paths = words.flatMap((w) =>
    isScriptBlock(w) ? scriptBlockWords(w).filter((b) => !b.startsWith("-")) : wordPaths(cmd, w),
  );
  if ((paths.length === 0 || words.some(isScriptBlock)) && cmdlet.here) {
    paths = [...paths, ...(source ? listedPaths(source) : ["."])];
  }
  const name = cmdlet.creates ? valuesOf(named, "name")[0] : undefined;
  let targets = name ? paths.map((p) => `${p.replace(/[\\/]+$/, "")}\\${name}`) : paths;
  const type = valuesOf(named, "itemtype")[0] ?? valuesOf(named, "type")[0];
  if (cmdlet.folder || (cmdlet.creates && /^["']?d/i.test(type ?? ""))) {
    // A folder on disk follows `mkdir`'s rule; only a key on a PowerShell drive is judged.
    targets = targets.filter((t) => {
      const provider = providerPath(t, ctx);
      return provider !== undefined && provider.path === undefined;
    });
  }
  if (cmdlet.moves) return { targets, words: [] };
  return { targets, words: name ? [...words, name] : words };
}

/**
 * The named parameters (lower-cased, without the dash) and positional words of a cmdlet call.
 * `switches`: its parameters that take no value.
 */
export function readParams(
  args: string[],
  switches: readonly string[] = SWITCHES,
): { named: Map<string, string[]>; positional: string[] } {
  const named = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = PARAM.exec(arg);
    if (!param) {
      // `--parents` and other POSIX long options of `mkdir` take no separate value.
      if (!arg.startsWith("--")) positional.push(arg);
      continue;
    }
    const name = (param[1] as string).toLowerCase();
    let value = param[2];
    if (value === undefined) {
      if (switches.some((s) => s.startsWith(name))) continue;
      value = args[i + 1];
      i += 1;
    }
    if (value !== undefined) named.set(name, [...(named.get(name) ?? []), value]);
  }
  return { named, positional };
}

/** The values given for parameter `full`: by its name, an alias in `PATHS`, or a prefix of it. */
export function valuesOf(named: Map<string, string[]>, full: string): string[] {
  const out: string[] = [];
  for (const [name, values] of named) {
    if (name === full || (name.length >= 2 && full.startsWith(name))) out.push(...values);
  }
  return out;
}
