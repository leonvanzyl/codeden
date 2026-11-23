import { binName, unwrap } from "./command-words";
import type { SimpleCommand } from "./shell";

/**
 * Downloads piped into an interpreter that runs them (§11.2): `curl … | sh`,
 * `wget -qO- … | bash -s --`, `irm … | iex`, `curl … | cmd`, `curl … | python3 -`. An interpreter that gets
 * its program another way (`node -e '…'`, `python -c '…'`, `python -m json.tool`,
 * `node script.mjs`) only reads the download as data, so `curl … | node -e '…'` is not one.
 * Works on parsed commands, so a `|` inside quotes (`sed 's|a|b|'`) is not a pipe.
 */
export function pipesDownloadIntoInterpreter(list: SimpleCommand[]): boolean {
  let downloaded = false;
  for (const cmd of list) {
    if (!cmd.piped) downloaded = false;
    else if (downloaded && runsStdin(cmd)) return true;
    // Filters keep the download flowing: `curl … | tee log | sh` still runs it.
    if (downloads(cmd)) downloaded = true;
  }
  return false;
}

const DOWNLOADERS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
]);

/** True when the command, or a substitution inside it, fetches something from the web. */
function downloads(cmd: SimpleCommand): boolean {
  if (DOWNLOADERS.has(binName(unwrap(cmd.words).tokens[0]))) return true;
  if (cmd.words.some((w) => /downloadstring/i.test(w))) return true;
  return cmd.nested.some((list) => list.some(downloads));
}

/** How an interpreter's flags decide where its program comes from. */
interface Interpreter {
  /** The flag's value is the program (`-c`, `-e`, `-m`, `-File`), so stdin is only data. */
  program(flag: string): boolean;
  /** The flag reads the program from stdin (`sh -s`). */
  stdin?(flag: string): boolean;
  /** The flag takes the next word as its value (`bash -o pipefail`, `node -r ./x.js`). */
  valued(flag: string): boolean;
}

const SHELL: Interpreter = {
  program: (f) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(f) || f === "--command",
  stdin: (f) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(f),
  valued: (f) =>
    /^[-+][a-zA-Z]*[oO]$/.test(f) ||
    ["--rcfile", "--init-file", "-C", "--init-command"].includes(f),
};

const PYTHON: Interpreter = {
  program: (f) => /^-[bBdEiIOqsSuvxRP]*[cm]$/.test(f),
  valued: (f) => f === "-W" || f === "-X" || f === "--check-hash-based-pycs",
};

const NODE: Interpreter = {
  program: (f) => /^-(e|p|pe|ep)$/.test(f) || /^--(eval|print)(=|$)/.test(f),
  valued: (f) =>
    [
      "-r",
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
      "-C",
      "--conditions",
      "--input-type",
      "--env-file",
      "--title",
    ].includes(f),
};

const PERL: Interpreter = {
  program: (f) => /^-[acnpstuvwlTUW0-9]*[eE]$/.test(f),
  valued: (f) => f === "-I" || f === "-M" || f === "-m",
};

const RUBY: Interpreter = {
  program: (f) => /^-[nplacdvwys]*e$/.test(f),
  valued: (f) => ["-I", "-r", "-C", "-E"].includes(f),
};

const PWSH_SWITCHES = new Set([
  "-noprofile",
  "-nop",
  "-nologo",
  "-nol",
  "-noninteractive",
  "-noni",
  "-noexit",
  "-noe",
  "-mta",
  "-sta",
  "-login",
  "-l",
  "-interactive",
  "-i",
]);

const POWERSHELL: Interpreter = {
  program: (f) => /^-(c|command|e|ec|encodedcommand|f|file)$/i.test(f),
  // Most PowerShell parameters take a value; assume an unknown one does.
  valued: (f) => !PWSH_SWITCHES.has(f.toLowerCase()),
};

/** `source file` and `. file` run the file in the current shell. */
const SOURCE: Interpreter = { program: () => false, valued: () => false };

const INTERPRETERS = new Map<string, Interpreter>([
  ...["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"].map(
    (b) => [b, SHELL] as [string, Interpreter],
  ),
  ["node", NODE],
  ["nodejs", NODE],
  ["perl", PERL],
  ["ruby", RUBY],
  ["pwsh", POWERSHELL],
  ["powershell", POWERSHELL],
  ["source", SOURCE],
  [".", SOURCE],
]);

const interpreter = (bin: string): Interpreter | undefined =>
  INTERPRETERS.get(bin) ?? (/^(python[\d.]*|py|pypy3?)$/.test(bin) ? PYTHON : undefined);

/** A program argument that means "read the program from stdin". */
const isStdin = (arg: string | undefined): boolean =>
  arg === undefined || arg === "-" || arg === "/dev/stdin" || arg === "/proc/self/fd/0";

/**
 * True when the command runs what it reads on stdin as code: an interpreter given no program
 * (no `-c`/`-e` code, module or script file), or told to read it from stdin (`-`, `sh -s`).
 */
function runsStdin(cmd: SimpleCommand): boolean {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (bin === "iex" || bin === "invoke-expression") return true;
  // cmd runs the lines it reads unless `/c` gives it a command (#550). `/k` runs its command,
  // if any, and then goes on reading.
  if (bin === "cmd") return !tokens.slice(1).some((a) => /^\/\/?c$/i.test(a));
  const spec = interpreter(bin);
  if (!spec) return false;
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return isStdin(args[i + 1]);
    // The first word that isn't a flag is the script file (or PowerShell's command text).
    if (!/^[-+]./.test(arg)) return isStdin(arg);
    if (spec.stdin?.(arg)) return true;
    if (spec.program(arg)) return !arg.includes("=") && isStdin(args[i + 1]);
    if (spec.valued(arg)) i += 1;
  }
  return true;
}
