import path from "node:path";

/**
 * The interactive shell CodeDen's terminals run (§12.1): `CODEDEN_SHELL`, else PowerShell on
 * Windows and the user's `$SHELL` elsewhere. Shared by the runner, which starts terminals,
 * and the server, which writes commands to type into them.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CODEDEN_SHELL) return env.CODEDEN_SHELL;
  if (platform === "win32") return "powershell.exe";
  return env.SHELL || "/bin/bash";
}

/** Shells that take `-l` to start as a login shell. */
const LOGIN_SHELLS = new Set(["zsh", "bash", "sh", "ksh", "dash", "fish", "tcsh", "csh"]);

/**
 * The arguments the default shell of a terminal starts with. On macOS it is a login shell
 * (`-l`), as in the system's own terminal: the PATH set up for Homebrew, nvm and the like
 * usually lives in `~/.zprofile` or `~/.bash_profile`, which only a login shell reads, and an
 * app started from the Dock has only the system's bare PATH to hand down. Elsewhere the login
 * session has already set the environment up, so the shell starts plain.
 */
export function defaultShellArgs(
  shell: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "darwin") return [];
  return LOGIN_SHELLS.has(path.posix.basename(shell).toLowerCase()) ? ["-l"] : [];
}

/** How a shell parses a command line. */
export type ShellSyntax = "powershell" | "cmd" | "posix";

/** The syntax family of a shell, by its file name. */
export function shellSyntax(shell: string): ShellSyntax {
  const base = path.win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (base === "powershell" || base === "pwsh") return "powershell";
  if (base === "cmd") return "cmd";
  return "posix";
}

/** Words each shell takes literally without quotes. */
const PLAIN: Record<ShellSyntax, RegExp> = {
  powershell: /^[\w@%+=:,./\\-]+$/,
  cmd: /^[\w@+=:,./\\-]+$/,
  posix: /^[\w@%+=:,./-]+$/,
};

/** Quote one word so `shell` passes it through unchanged. */
export function quoteForShell(word: string, syntax: ShellSyntax): string {
  if (word !== "" && PLAIN[syntax].test(word)) return word;
  switch (syntax) {
    case "powershell":
      return `'${word.replace(/'/g, "''")}'`;
    case "cmd":
      // Quotes are not allowed inside a Windows file name or these arguments.
      return `"${word.replace(/"/g, "")}"`;
    case "posix":
      return `'${word.replace(/'/g, `'\\''`)}'`;
  }
}

/**
 * A command line that runs `program` (a full path) with `args` when typed into `shell`, e.g.
 * `& 'C:\Users\x\.local\bin\claude.exe' auth login` in PowerShell, `"C:\...\claude.exe" auth
 * login` in cmd and `'/home/x/.local/bin/claude' auth login` in POSIX shells. A bare command
 * name is left as it is.
 */
export function shellCommandLine(shell: string, program: string, args: readonly string[]): string {
  const syntax = shellSyntax(shell);
  const isPath = program.includes("/") || program.includes("\\");
  const head = isPath
    ? syntax === "powershell"
      ? `& '${program.replace(/'/g, "''")}'`
      : syntax === "cmd"
        ? `"${program}"`
        : quoteForShell(program, "posix")
    : program;
  return [head, ...args.map((a) => quoteForShell(a, syntax))].join(" ");
}
