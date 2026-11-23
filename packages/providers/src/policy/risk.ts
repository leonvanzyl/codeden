import { currentGitBranch } from "../util/git-head";
import { agentPermissionsCommand, agentPermissionsWrite } from "./agent-permissions";
import { type RiskAssessment, risky, SAFE } from "./assessment";
import { CODEDEN_WHAT, codedenCommand, pathsOf } from "./codeden-command";
import {
  codedenAccess,
  credentialsRisk,
  forReading,
  touchesCodedenCredentials,
  touchesCodedenHome,
} from "./codeden-home";
import {
  binName,
  DISCARD,
  isScriptBlock,
  joinScriptBlocks,
  namedArg,
  scriptBlockWords,
  unwrap,
} from "./command-words";
import { classifyDelete } from "./deletes";
import { downloadWrites } from "./downloads";
import { dumpsEnvironment } from "./env-dumps";
import { type ListOutput, namesOnly } from "./env-names";
import { classifyGit } from "./git";
import { type InlineScript, inlineScripts } from "./inline-scripts";
import { classifyInstall } from "./installs";
import { itemWrites } from "./item-writes";
import { locationsAfter, MAX_LOCATIONS, moveTo } from "./locations";
import {
  isInside,
  isInWorkspace,
  isSecretPath,
  isTempRoot,
  isWritable,
  type PathContext,
  providerPath,
  resolveAgainst,
  SHELL_DRIVES,
} from "./paths";
import { projectConfigCommand, projectConfigWrite } from "./project-config";
import { loginRisk, providerLoginCommand, touchesProviderLogin } from "./provider-logins";
import { keptWords } from "./ps-assignments";
import { registryChange, registryExports } from "./registry";
import { pipesDownloadIntoInterpreter } from "./remote-scripts";
import { braceAlternatives, secretArgument, toolOutputs } from "./secrets";
import { parseShell, type ShellDialect, type SimpleCommand } from "./shell";

/**
 * Risky-action classifier for the `auto` and `full` autonomy levels (§11.2). Provider-neutral:
 * adapters translate their tool calls into `classifyCommand` / `classifyWrite` /
 * `classifyRead` / `classifyFetch` calls. A risky result is turned into an approval request;
 * everything else runs freely. Writes inside the worktree, the extra roots and the OS temp
 * directory are not risky; secrets files are, wherever they are.
 */
export type { RiskAssessment };

export interface RiskContext extends PathContext {
  /** Hosts the agent may fetch freely. When omitted, web fetches are not flagged. */
  allowedHosts?: readonly string[];
  /** The shell a command runs in, for its quoting rules. Default `auto`. */
  shell?: ShellDialect;
  /** The branch the session owns, which it may force-push with a lease (§11.2). */
  ownBranch?: string;
  /** The branch checked out in the worktree. Defaults to reading `cwd`'s git `HEAD`. */
  currentBranch?: () => string | undefined;
}

/** How deep `bash -c "…"` style inline scripts are followed. */
const MAX_DEPTH = 4;

/**
 * Classify a shell command (any shell: POSIX, PowerShell or cmd). Downloads piped into an
 * interpreter (`curl … | sh`, `irm … | iex`) are found on the parsed pipeline in
 * `classifyList`; here, a download run through a substitution (`iex (irm …)`,
 * `bash -c "$(curl …)"`, `bash <(curl …)`). CodeDen's own home and credentials, then the agent
 * CLIs' logins, are looked for first, across the whole command, so an earlier ordinary risk
 * (`cat .env; …`) can't hide them.
 */
export function classifyCommand(command: string, ctx: RiskContext): RiskAssessment {
  const list = parseShell(command, ctx.shell ?? "auto");
  // What every level asks about, looked for across the whole command first: CodeDen's own home
  // and credentials, an agent CLI's login, then a write of an agent's own allow-list.
  const always =
    firstInList(list, ctx, 0, codedenCommand) ??
    firstInList(list, ctx, 0, (cmd, here) => providerLoginCommand(cmd, here)) ??
    firstInList(list, ctx, 0, (cmd, here) => agentPermissionsCommand(cmd, here));
  if (always) return always;
  if (
    /\b(iex|invoke-expression)\b[^|]*\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i.test(
      command,
    )
  ) {
    return risky("network", "Executes a downloaded script");
  }
  if (
    /\b(bash|sh|zsh)\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i.test(command) ||
    /<\(\s*(curl|wget)\b/i.test(command)
  ) {
    return risky("network", "Executes a downloaded script");
  }
  return classifyList(list, ctx, 0);
}

/**
 * One simple command's verdict for `firstInList`. `feeds`: its output is used by another
 * command (it sits in a substitution or a pipe).
 */
type CommandCheck = (
  cmd: SimpleCommand,
  ctx: RiskContext,
  feeds: boolean,
) => RiskAssessment | undefined;

/**
 * The first verdict `check` gives anywhere in `list`: substitutions, subshells and inline
 * scripts (`bash -c "…"`) included, following `cd` like `classifyList`.
 */
function firstInList(
  list: SimpleCommand[],
  ctx: RiskContext,
  depth: number,
  check: CommandCheck,
  feeds = false,
): RiskAssessment | undefined {
  let heres = [ctx];
  for (const [i, cmd] of list.entries()) {
    const piped = list[i + 1]?.piped === true;
    const { tokens } = unwrap(cmd.words);
    const bin = binName(tokens[0]);
    const scripts = depth < MAX_DEPTH ? inlineScripts(bin, tokens.slice(1), cmd) : [];
    for (const here of heres) {
      for (const nested of cmd.nested) {
        const found = firstInList(nested, here, depth, check, true);
        if (found) return found;
      }
      for (const script of scripts) {
        const inner = parseShell(script.text, script.dialect);
        const into = feeds || piped || script.feeds === true;
        const found = firstInList(inner, scriptContext(script, here), depth + 1, check, into);
        if (found) return found;
      }
      for (const one of withKept(cmd)) {
        const found = check(one, here, feeds || piped);
        if (found) return found;
      }
    }
    heres = locationsAfter(cmd, heres);
    // A location past the limit isn't checked, so it may be CodeDen's home: every level asks.
    if (heres.length > MAX_LOCATIONS) return TOO_MANY_LOCATIONS;
  }
  return undefined;
}

/** A command line that may leave the shell in more folders than are followed (`./locations`). */
const TOO_MANY_LOCATIONS: RiskAssessment = {
  risky: true,
  action: "outside_worktree",
  reason: "Changes folders in more ways than can be followed",
  always: true,
};

/**
 * Classify commands in order. A `cd` moves where later relative paths resolve; commands in
 * substitutions and subshells are classified too, without their `cd` leaking out. `output`: where
 * the list's output goes, which decides whether an environment listing that keeps only the names
 * is a dump (`./env-names`): substitutions hand theirs to another command, except a `(…).Name`
 * group, which keeps only the names itself.
 */
function classifyList(
  list: SimpleCommand[],
  ctx: RiskContext,
  depth: number,
  output: ListOutput = "shown",
): RiskAssessment {
  if (pipesDownloadIntoInterpreter(list)) {
    return risky("network", "Pipes a downloaded script straight into a shell");
  }
  const names = namesOnly(list, output);
  // Where the shell may be: one location, unless a pop may or may not happen (`./locations`).
  let heres = [ctx];
  let head = 0;
  for (const [i, cmd] of list.entries()) {
    if (!cmd.piped) head = i;
    const shown = output === "shown" && list[i + 1]?.piped !== true;
    const source = cmd.piped ? list[head] : undefined;
    const at = { namesOnly: names.listings.has(i), shown, source };
    for (const here of heres) {
      for (const [k, nested] of cmd.nested.entries()) {
        const into = k === 0 && names.projections.has(i) ? "names" : "feeds";
        const result = classifyList(nested, here, depth, into);
        if (result.risky) return result;
      }
      for (const one of withKept(cmd)) {
        const result = classifySimple(one, here, depth, at);
        if (result.risky) return result;
      }
    }
    heres = locationsAfter(cmd, heres);
    if (heres.length > MAX_LOCATIONS) return TOO_MANY_LOCATIONS;
  }
  return SAFE;
}

/** `cmd`, then what a PowerShell assignment in it keeps in its variable (`keptWords`). */
function withKept(cmd: SimpleCommand): SimpleCommand[] {
  const kept = keptWords(cmd);
  return kept ? [cmd, kept] : [cmd];
}

/**
 * Where an inline script runs: in its own folder when it names one (`Start-Process
 * -WorkingDirectory`), in a new process, which starts with a location stack of its own.
 */
function scriptContext(script: InlineScript, ctx: RiskContext): RiskContext {
  const fresh = { ...ctx, pushed: undefined };
  return script.dir ? moveTo(script.dir, fresh) : fresh;
}

/**
 * Where a simple command stands in its list. `namesOnly`: it lists the environment but only the
 * names reach the agent (`./env-names`). `shown`: its output reaches the agent, not another command.
 * `source`: when it reads a pipe, the command at the head of that pipeline (`./deletes`).
 */
interface Placement {
  namesOnly: boolean;
  shown: boolean;
  source?: SimpleCommand;
}

function classifySimple(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const { tokens, elevated } = unwrap(cmd.words);
  if (elevated) return risky("other", "Runs a command with elevated privileges");
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  // Inline scripts (`bash -c "…"`), the commands of cmd's `for` loop and what Start-Process starts.
  for (const script of depth < MAX_DEPTH ? inlineScripts(bin, args, cmd) : []) {
    if (script.elevated) return risky("other", "Runs a command with elevated privileges");
    const output = at.shown && !script.feeds ? "shown" : "feeds";
    const list = parseShell(script.text, script.dialect);
    const inner = classifyList(list, scriptContext(script, ctx), depth + 1, output);
    if (inner.risky) return inner;
  }

  for (const target of cmd.writes) {
    if (DISCARD.test(target)) continue;
    const write = classifyWrite(target, ctx);
    if (write.risky) return write;
  }

  if (bin === "git") {
    const verdict = classifyGit(args, {
      ownBranch: ctx.ownBranch,
      currentBranch: ctx.currentBranch ?? (() => currentGitBranch(ctx.cwd)),
      inWorktree: isInside(resolveAgainst(".", ctx), ctx.cwd, ctx),
    });
    // `git checkout <ref> -- .codeden/project.json` writes CodeDen's project config.
    return verdict.risky ? verdict : (projectConfigCommand(cmd, ctx) ?? SAFE);
  }

  const install = classifyInstall(bin, lower);
  if (install.risky) return install;

  const deletes = classifyDelete(cmd, ctx, at.source);
  if (deletes.risky) return deletes;
  const registry = registryChange(bin, args, tokens);
  if (registry) return registry;

  const dest = copyDestination(bin, args);
  // A destination a script block computes (`-Destination { 'C:\Old\' + $_.Name }`): any of its
  // words may name it.
  const block = dest !== undefined && isScriptBlock(dest);
  const dests = !dest
    ? []
    : block
      ? scriptBlockWords(dest).filter((w) => !w.startsWith("-"))
      : [dest];
  const outputs = [...toolOutputs(bin, args), ...registryExports(bin, args)];
  const items = itemWrites(cmd, ctx, at.source);
  const downloads = downloadWrites(cmd, ctx);
  const written = [...dests, ...outputs, ...items.words, ...downloads.words];
  const targets = [...(dest && !block ? copyTargets(bin, args, dest, ctx) : dests), ...outputs];
  for (const target of [...targets, ...items.targets, ...downloads.targets]) {
    const write = classifyWrite(target, ctx);
    if (write.risky) return write;
  }

  // A file PowerShell's variable syntax reads (`${C:\Users\me\.ssh\id_rsa}`), whatever the command.
  for (const item of cmd.reads ?? []) {
    const read = classifyRead(item, ctx);
    if (read.risky) return read;
  }

  // Secrets: any argument (or element of a PowerShell list) that reads a credentials file.
  const secret = secretArgument(bin, args, written, isSecretPath, pathsOf(cmd));
  if (secret) return risky("secrets", `Accesses the secrets file ${secret}`);

  if (!at.namesOnly && dumpsEnvironment(bin, args)) {
    return risky("secrets", "Dumps environment variables");
  }
  // CodeDen's project config: `sed -i`, `git checkout --` and inline code reach it too.
  return projectConfigCommand(cmd, ctx) ?? SAFE;
}

const COPIES = ["cp", "mv", "copy", "move", "copy-item", "move-item", "xcopy", "robocopy"];
const WRITERS = ["tee", "set-content", "out-file", "add-content"];
/** cmd-style copies, whose `/X` words are switches; for `cp` and `mv`, `/tmp` is a path. */
const CMD_COPIES = ["copy", "move", "xcopy", "robocopy"];

/** The path-like words of a copy or write: not options, nor cmd switches (`/E`, `/R:3`). */
function operands(bin: string, args: string[]): string[] {
  return args.filter(
    (a) => !a.startsWith("-") && !(CMD_COPIES.includes(bin) && /^\/[a-z]+(:\S*)?$/i.test(a)),
  );
}

/** Where a copy, move or file-writing command writes: a path, or a script block computing one. */
function copyDestination(bin: string, words: string[]): string | undefined {
  if (!COPIES.includes(bin) && !WRITERS.includes(bin)) return undefined;
  const args = joinScriptBlocks(words);
  const named = WRITERS.includes(bin)
    ? namedArg(args, ["-path", "-filepath", "-literalpath"])
    : namedArg(args, ["-destination"]);
  if (named) return named;
  const positional = operands(bin, args);
  return WRITERS.includes(bin) ? positional[0] : positional.at(-1);
}

/**
 * The paths a copy or write lands on. A copy into a temp directory itself (`cp a.png /tmp/`)
 * writes the copied names inside it, so they are checked instead (a secrets file there asks).
 */
function copyTargets(bin: string, args: string[], dest: string, ctx: RiskContext): string[] {
  if (!COPIES.includes(bin) || !isTempRoot(dest, ctx)) return [dest];
  const sources = operands(bin, args).filter((a) => a !== dest);
  const names = sources
    .map(
      (s) =>
        s
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? "",
    )
    .filter(Boolean);
  return names.length ? names.map((name) => `${dest.replace(/[\\/]+$/, "")}/${name}`) : [dest];
}

/**
 * Classify a file write/edit. The worktree, extra roots and OS temp are fine, secrets files in
 * the worktree included: writing one (`cp .env.example .env`) reads nothing. A secrets file in
 * temp counts as outside the worktree, so Full autonomy (which only asks for writes outside the
 * worktree) still asks for it. CodeDen's own home (its credential files, and anything else
 * outside the session's own worktree there) and agents' own allow-lists (`./agent-permissions`)
 * ask at every level. CodeDen's project config (`./project-config`) asks at Auto. On Windows a
 * PowerShell drive's item (`HKCU:\…`, `Cert:\…`, or a relative path after a `cd` there) is never
 * in the worktree, except on the shell's own `Env:`, `Variable:`, `Function:` and `Alias:`
 * drives; `FileSystem::C:\x` and `Temp:\x` are the files they name.
 */
export function classifyWrite(target: string, ctx: RiskContext): RiskAssessment {
  const provider = providerPath(target, ctx);
  if (provider?.path !== undefined) return classifyWrite(provider.path, ctx);
  if (provider) {
    if (SHELL_DRIVES.has(provider.drive)) return SAFE;
    return risky("outside_worktree", `Writes ${target}, outside the worktree`);
  }
  const access = codedenAccess(target, ctx);
  if (access) return credentialsRisk(`Writes ${CODEDEN_WHAT[access]}: ${target}`);
  const permissions = agentPermissionsWrite(target, ctx);
  if (permissions) return permissions;
  if (!isWritable(target, ctx))
    return risky("outside_worktree", `Writes ${target}, outside the worktree`);
  if (isSecretPath(target) && !isInWorkspace(target, ctx)) {
    return risky("outside_worktree", `Writes the secrets file ${target}, outside the worktree`);
  }
  return projectConfigWrite(target, ctx) ?? SAFE;
}

/**
 * Classify a file read or search. Reads anywhere are fine except credential files and CodeDen's
 * own home: anything there outside the session's own worktree and its own artifacts folder, and
 * the agent CLIs' logins (or a folder holding them), ask at every level.
 */
export function classifyRead(target: string, ctx: RiskContext): RiskAssessment {
  const access = codedenAccess(target, forReading(ctx));
  if (access) return credentialsRisk(`Reads ${CODEDEN_WHAT[access]}: ${target}`);
  if (touchesProviderLogin(target, ctx)) return loginRisk(`Reads an agent CLI's login: ${target}`);
  if (isSecretPath(target)) return risky("secrets", `Reads the secrets file ${target}`);
  return SAFE;
}

/**
 * Classify a file-name search: `pattern` (Claude's Glob, or a search's `--glob` filter) from
 * `base` (default: the current directory). Listing names reads nothing, so only a pattern that
 * reaches CodeDen's own home (its credential files, or anything outside the session's own
 * worktree and artifacts folder there) asks; `{a,b}` alternatives are followed.
 */
export function classifyGlob(
  pattern: string,
  base: string | undefined,
  ctx: RiskContext,
): RiskAssessment {
  if (!pattern.trim()) return SAFE;
  const dir = base ? resolveAgainst(base, ctx) : (ctx.dir ?? ctx.cwd);
  const alts = braceAlternatives(pattern);
  if (alts.some((alt) => touchesCodedenCredentials(alt, { ...ctx, dir }))) {
    return credentialsRisk(`Lists CodeDen's own credential files: ${pattern}`);
  }
  const reaches = alts.some((alt) => touchesCodedenHome(alt, forReading({ ...ctx, dir })));
  return reaches ? credentialsRisk(`Lists CodeDen's own home: ${pattern}`) : SAFE;
}

/** Classify a web fetch. Only flagged when the context has an allowlist of hosts. */
export function classifyFetch(url: string, ctx: RiskContext): RiskAssessment {
  if (!ctx.allowedHosts) return SAFE;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return risky("network", `Fetches an unparseable URL: ${url}`);
  }
  const allowed = ctx.allowedHosts.some((h) => {
    const rule = h.toLowerCase();
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule;
  });
  return allowed
    ? SAFE
    : risky("network", `Fetches ${host}, which is not on the allowed host list`);
}
