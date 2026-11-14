import type { RiskAssessment } from "./assessment";
import { binName, unwrap } from "./command-words";
import { type PathContext, resolveAgainst } from "./paths";
import { SEARCHES } from "./search-words";
import { asPath, braceAlternatives, DATA, LISTS, runsOnFound } from "./secrets";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * Agents' own permission files (§11.2). Cursor and Gemini CLI run what their allow-lists permit
 * without asking, so CodeDen never sees those calls. An agent that writes one (`echo … >
 * .cursor/cli.json`) would turn CodeDen's approvals off for itself and, once the file is merged,
 * for every later session in the project. So writing one asks at every level, Full included,
 * whichever agent writes it and wherever it is: the worktree, a folder in it, or the user's own
 * configuration.
 */

type Owner = "Cursor" | "Gemini CLI";

/** A path that holds an agent's permissions: one of its files, or a folder that holds them. */
export interface PermissionPath {
  owner: Owner;
  /** A folder holding them (`.cursor`, `.gemini/policies`): a copy into it may add one. */
  folder: boolean;
}

/**
 * What `target` is to an agent's permissions, compared in any case:
 * - Cursor: `.cursor/cli.json` (a project's), `cli-config.json` in `.cursor` or a `cursor`
 *   config folder (the user's);
 * - Gemini CLI: `settings.json` and `trustedFolders.json` in `.gemini` (a project's or the
 *   user's), the system `settings.json` and `system-defaults.json` in `gemini-cli`, and any
 *   policy file in `.gemini/policies` or `gemini-cli/policies`;
 * - the `.cursor` and `.gemini` folders themselves.
 */
export function agentPermissionPath(target: string, ctx: PathContext): PermissionPath | undefined {
  const parts = resolveAgainst(target, ctx)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const base = parts.at(-1) ?? "";
  const parent = parts.at(-2);
  const file = (owner: Owner) => ({ owner, folder: false });
  if (parent === ".cursor" && (base === "cli.json" || base === "cli-config.json")) {
    return file("Cursor");
  }
  if (parent === "cursor" && base === "cli-config.json") return file("Cursor");
  if (parent === ".gemini" && (base === "settings.json" || base === "trustedfolders.json")) {
    return file("Gemini CLI");
  }
  if (parent === "gemini-cli" && (base === "settings.json" || base === "system-defaults.json")) {
    return file("Gemini CLI");
  }
  const policies = parts.findIndex(
    (p, i) => p === "policies" && (parts[i - 1] === ".gemini" || parts[i - 1] === "gemini-cli"),
  );
  if (policies >= 0) return { owner: "Gemini CLI", folder: policies === parts.length - 1 };
  if (base === ".cursor") return { owner: "Cursor", folder: true };
  if (base === ".gemini") return { owner: "Gemini CLI", folder: true };
  return undefined;
}

/** A verdict on writing an agent's permissions, which every level asks about. */
export function agentPermissionsRisk(owner: Owner, target: string): RiskAssessment {
  return {
    risky: true,
    action: "file_change",
    reason: `Changes ${owner}'s own permissions (${target}): what they allow runs without CodeDen asking`,
    always: true,
  };
}

/** The verdict on writing `target` when it holds an agent's permissions, else undefined. */
export function agentPermissionsWrite(
  target: string,
  ctx: PathContext,
): RiskAssessment | undefined {
  const found = agentPermissionPath(target, ctx);
  return found ? agentPermissionsRisk(found.owner, target) : undefined;
}

/** Interpreters whose inline code may write a file (`node -e "fs.writeFileSync(…)"`). */
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
  "php",
]);

/** A permission file named in code (`'.cursor/cli.json'`, `".gemini\\settings.json"`). */
const MENTION =
  /\.(cursor)[\\/]+cli(-config)?\.json|\.(gemini)[\\/]+(settings\.json|trustedfolders\.json|policies)/i;

/** Commands that only read, list, search, delete or move between folders: none writes one. */
const NO_WRITE = new Set([
  ...DATA,
  ...SEARCHES,
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "wc",
  "diff",
  "cmp",
  "file",
  "jq",
  "cd",
  "pushd",
  "chdir",
  "set-location",
  "sl",
  "push-location",
  "mkdir",
  "md",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "unlink",
]);

/** Git commands that write files named in their arguments. */
const GIT_WRITES = new Set(["checkout", "restore", "mv"]);

/** Whether the command may write the paths its arguments name. */
function writesArguments(bin: string, args: readonly string[]): boolean {
  if (LISTS.has(bin)) return runsOnFound(bin, args);
  if (NO_WRITE.has(bin)) return false;
  if (bin !== "git") return true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-C" || arg === "-c") i += 1;
    else if (!arg.startsWith("-")) return GIT_WRITES.has(arg);
  }
  return false;
}

/**
 * One simple command's write of an agent's permissions: a redirect onto one, inline code that
 * names one (`node -e`, `python -c`, a PowerShell `[IO.File]::WriteAllText(…)`), or an argument
 * that is one, for any command that may write its arguments (`tee`, `cp`, `mv`, `sed -i`,
 * `Set-Content`, `Copy-Item`, `git checkout -- <file>`, ...). Reads, searches, listings and
 * deletions don't count.
 */
export function agentPermissionsCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  for (const target of cmd.writes) {
    const found = agentPermissionsWrite(target, ctx);
    if (found) return found;
  }
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (INTERPRETERS.has(bin) || tokens[0]?.startsWith("[")) {
    const named = MENTION.exec(tokens.join(" "));
    if (named) return agentPermissionsRisk(named[1] ? "Cursor" : "Gemini CLI", named[0]);
  }
  if (!writesArguments(bin, args)) return undefined;
  for (const arg of args) {
    for (const word of wordPaths(cmd, arg)) {
      for (const alt of braceAlternatives(word)) {
        const path = asPath(alt);
        const found = path === undefined ? undefined : agentPermissionsWrite(path, ctx);
        if (found) return found;
      }
    }
  }
  return undefined;
}
