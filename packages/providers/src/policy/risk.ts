import { currentGitBranch } from "../util/git-head";
import { agentPermissionsCommand, agentPermissionsWrite } from "./agent-permissions";
import { asksAtEveryLevel, mostSevere, type RiskAssessment, risky, SAFE } from "./assessment";
import { CODEDEN_WHAT, codedenCommand, pathsOf } from "./codeden-command";
import {
  codedenAccess,
  credentialsRisk,
  forReading,
  touchesCodedenCredentials,
  touchesCodedenHome,
} from "./codeden-home";
import { binName, DISCARD, unwrap } from "./command-words";
import { copyWrites } from "./copies";
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
import { codedenFolderRisk, folderRisk } from "./run-folder";
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
export function classifyCommand(command: string, given: RiskContext): RiskAssessment {
  // `CDPATH` sends a `cd` to a relative folder anywhere it lists, and `GIT_DIR` or
  // `GIT_WORK_TREE` a `cd` to the repository's top folder elsewhere (#614).
  const ctx = {
    ...given,
    cdPath: given.cdPath || /\bCDPATH\b/.test(command),
    gitEnv: given.gitEnv || /\bGIT_(?:DIR|WORK_TREE)\b/.test(command),
  };
  const list = parseShell(command, ctx.shell ?? "auto");
  // What every level asks about, looked for across the whole command first: CodeDen's own home
  // and credentials (and a command run there), an agent CLI's login, then a write of an agent's
  // own allow-list.
  const always =
    firstInList(list, ctx, 0, codedenCommand) ??
    firstInList(list, ctx, 0, (cmd, here) => codedenFolderRisk(cmd, here)) ??
    firstInList(list, ctx, 0, (cmd, here) => providerLoginCommand(cmd, here)) ??
    firstInList(list, ctx, 0, (cmd, here) => agentPermissionsCommand(cmd, here));
  if (always) return always;
  // Every part is weighed, and the most severe verdict returned (#627): a risk Full allows (a
  // downloaded script, a force push) must not hide a later write outside the worktree.
  const found: RiskAssessment[] = [];
  if (
    /\b(iex|invoke-expression)\b[^|]*\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i.test(
      command,
    )
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  if (
    /\b(bash|sh|zsh)\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i.test(command) ||
    /<\(\s*(curl|wget)\b/i.test(command)
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  found.push(classifyList(list, ctx, 0));
  return mostSevere(found);
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
        const found = firstInList(inner, scriptContext(script, cmd, here), depth + 1, check, into);
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
 * Classify commands in order, and return the most severe verdict of them all (`mostSevere`), not
 * the first: Full allows some risks, and one of those must not hide a later one it asks about
 * (`git push --force && rm -rf ~/x`, #627). A `cd` moves where later relative paths resolve; commands in
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
  const found: RiskAssessment[] = [];
  if (pipesDownloadIntoInterpreter(list)) {
    found.push(risky("network", "Pipes a downloaded script straight into a shell"));
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
        found.push(classifyList(nested, here, depth, into));
      }
      for (const one of withKept(cmd)) found.push(classifySimple(one, here, depth, at));
    }
    heres = locationsAfter(cmd, heres);
    if (heres.length > MAX_LOCATIONS) return mostSevere([...found, TOO_MANY_LOCATIONS]);
  }
  return mostSevere(found);
}

/** `cmd`, then what a PowerShell assignment in it keeps in its variable (`keptWords`). */
function withKept(cmd: SimpleCommand): SimpleCommand[] {
  const kept = keptWords(cmd);
  return kept ? [cmd, kept] : [cmd];
}

/**
 * Where an inline script of `cmd` runs: where `env -C` moved it (`env -C dir bash -c …`), then in
 * its own folder when it names one (`Start-Process -WorkingDirectory`), in a new process, which
 * starts with a location stack of its own.
 */
function scriptContext(script: InlineScript, cmd: SimpleCommand, ctx: RiskContext): RiskContext {
  let fresh: RiskContext = { ...ctx, pushed: undefined };
  for (const dir of unwrap(cmd.words).chdir) fresh = moveTo(dir, fresh);
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

/**
 * One simple command's verdict. Anything but a read run outside the worktree asks as a write there
 * (`./run-folder`, #614), so Full asks too: that beats a risk Full lets through (a force push in
 * another repository), while a write outside the worktree the checks found keeps its own reason.
 * What a shell's inline script or `Start-Process` runs is judged where it runs instead, unless the
 * shell is handed another repository (`GIT_DIR=… bash -c …`), which its script would use.
 */
function classifySimple(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const verdict = classifyActions(cmd, ctx, depth, at);
  if (verdict.risky && (verdict.action === "outside_worktree" || asksAtEveryLevel(verdict))) {
    return verdict;
  }
  const { tokens, assigns } = unwrap(cmd.words);
  const scripts = depth < MAX_DEPTH ? inlineScripts(binName(tokens[0]), tokens.slice(1), cmd) : [];
  const gitVars = assigns.some((a) => /^GIT_(?:DIR|WORK_TREE)=/.test(a));
  return (scripts.length > 0 && !gitVars ? undefined : folderRisk(cmd, ctx)) ?? verdict;
}

/**
 * What one simple command does: the classifier's checks, wherever it runs. Every check is made,
 * and the most severe verdict returned: `sudo rm -rf ~/x` is a delete outside the worktree, not
 * only an elevated command, and so is the script an elevated `Start-Process` runs.
 */
function classifyActions(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const { tokens, elevated } = unwrap(cmd.words);
  const found: RiskAssessment[] = [];
  if (elevated) found.push(risky("other", "Runs a command with elevated privileges"));
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  // Inline scripts (`bash -c "…"`), the commands of cmd's `for` loop and what Start-Process starts.
  for (const script of depth < MAX_DEPTH ? inlineScripts(bin, args, cmd) : []) {
    if (script.elevated) found.push(risky("other", "Runs a command with elevated privileges"));
    const output = at.shown && !script.feeds ? "shown" : "feeds";
    const list = parseShell(script.text, script.dialect);
    found.push(classifyList(list, scriptContext(script, cmd, ctx), depth + 1, output));
  }

  for (const target of cmd.writes) {
    if (DISCARD.test(target)) continue;
    found.push(classifyWrite(target, ctx));
  }

  if (bin === "git") {
    const verdict = classifyGit(args, {
      ownBranch: ctx.ownBranch,
      currentBranch: ctx.currentBranch ?? (() => currentGitBranch(ctx.cwd)),
      inWorktree: isInside(resolveAgainst(".", ctx), ctx.cwd, ctx),
    });
    // `git checkout <ref> -- .codeden/project.json` writes CodeDen's project config.
    found.push(verdict.risky ? verdict : (projectConfigCommand(cmd, ctx) ?? SAFE));
    return mostSevere(found);
  }

  found.push(classifyInstall(bin, lower), classifyDelete(cmd, ctx, at.source));
  const registry = registryChange(bin, args, tokens);
  if (registry) found.push(registry);

  const copies = copyWrites(bin, args, ctx);
  const outputs = [...toolOutputs(bin, args), ...registryExports(bin, args)];
  const items = itemWrites(cmd, ctx, at.source);
  const downloads = downloadWrites(cmd, ctx);
  const written = [...copies.words, ...outputs, ...items.words, ...downloads.words];
  const targets = [...copies.targets, ...outputs, ...items.targets, ...downloads.targets];
  for (const target of targets) found.push(classifyWrite(target, ctx));

  // A file PowerShell's variable syntax reads (`${C:\Users\me\.ssh\id_rsa}`), whatever the command.
  for (const item of cmd.reads ?? []) found.push(classifyRead(item, ctx));

  // Secrets: any argument (or element of a PowerShell list) that reads a credentials file.
  const secret = secretArgument(bin, args, written, isSecretPath, pathsOf(cmd));
  if (secret) found.push(risky("secrets", `Accesses the secrets file ${secret}`));

  if (!at.namesOnly && dumpsEnvironment(bin, args)) {
    found.push(risky("secrets", "Dumps environment variables"));
  }
  // CodeDen's project config: `sed -i`, `git checkout --` and inline code reach it too.
  found.push(projectConfigCommand(cmd, ctx) ?? SAFE);
  return mostSevere(found);
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
