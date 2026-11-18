import { homedir } from "node:os";
import path from "node:path";

export interface KnownLocationOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The user's home folder (defaults to `os.homedir()`). */
  home?: string;
  /**
   * Read for `CODEX_HOME`, `ProgramFiles` and the package managers' folders (`BUN_INSTALL`,
   * `PNPM_HOME`, `VOLTA_HOME`, `npm_config_prefix`, `XDG_DATA_HOME`); defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Tools that package managers install globally (npm, pnpm, Bun, Volta, Homebrew): after their
 * own installer's folders, their global bin folders are tried too (`globalBinDirs`).
 */
const GLOBAL_TOOLS = new Set(["claude", "codex", "opencode", "gemini", "gh"]);

/**
 * Where a tool's own installer puts it, checked after PATH (§14), then, for the agent CLIs and
 * `gh` on macOS and Linux, the package managers' global bin folders. Native installers often
 * leave their folder off PATH, PATH may have changed after CodeDen started, and an app started
 * from the Dock or Finder gets the system's minimal PATH when the user's login shell could not
 * be read, so a tool installed this way is still found. Unknown tools have none.
 */
export function knownLocations(name: string, opts: KnownLocationOptions = {}): string[] {
  const own = installerLocations(name, opts);
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" || !GLOBAL_TOOLS.has(name)) return own;
  const globals = globalBinDirs(opts).map((dir) => path.posix.join(dir, name));
  return [...new Set([...own, ...globals])];
}

/**
 * The global bin folders of the usual package managers on macOS and Linux, most specific
 * first: Bun (`$BUN_INSTALL/bin`), pnpm (`$PNPM_HOME`, else its default folder), Volta,
 * npm's prefix (`$npm_config_prefix/bin`, `~/.npm-global/bin`), `~/.local/bin`, then
 * Homebrew's and `/usr/local/bin`. None on Windows, where npm's folder is on the user's Path.
 */
export function globalBinDirs(opts: KnownLocationOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return [];
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const p = path.posix;
  const pnpmDefault =
    platform === "darwin"
      ? p.join(home, "Library", "pnpm")
      : p.join(env.XDG_DATA_HOME || p.join(home, ".local", "share"), "pnpm");
  const dirs = [
    p.join(env.BUN_INSTALL || p.join(home, ".bun"), "bin"),
    env.PNPM_HOME || pnpmDefault,
    p.join(env.VOLTA_HOME || p.join(home, ".volta"), "bin"),
    ...(env.npm_config_prefix ? [p.join(env.npm_config_prefix, "bin")] : []),
    p.join(home, ".npm-global", "bin"),
    p.join(home, ".local", "bin"),
    ...(platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : ["/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin"]),
  ];
  return [...new Set(dirs)];
}

/** The folders a tool's own installer (or its usual install method) uses. */
function installerLocations(name: string, opts: KnownLocationOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const home = opts.home ?? homedir();
  const exe = (file: string) => (win ? `${file}.exe` : file);
  switch (name) {
    case "claude":
      // The native installer: `~/.local/bin`; older local installs: `~/.claude/local`.
      return win
        ? [p.join(home, ".local", "bin", "claude.exe")]
        : [p.join(home, ".local", "bin", "claude"), p.join(home, ".claude", "local", "claude")];
    case "codex": {
      // The standalone installer keeps releases under `$CODEX_HOME/packages/standalone`
      // and links `~/.local/bin/codex` to the current one on macOS and Linux.
      const standalone = p.join(env.CODEX_HOME || p.join(home, ".codex"), "packages", "standalone");
      return [
        ...(win ? [] : [p.join(home, ".local", "bin", "codex")]),
        p.join(standalone, "current", "bin", exe("codex")),
        p.join(standalone, "current", exe("codex")),
      ];
    }
    case "cursor-agent":
    case "agent": {
      // Cursor's CLI installer: `~/.local/bin` on macOS and Linux; on Windows a launcher
      // (`agent.cmd`) in `%LOCALAPPDATA%\cursor-agent`.
      if (!win) return [p.join(home, ".local", "bin", name)];
      const local = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
      return [p.join(local, "cursor-agent", `${name}.cmd`)];
    }
    case "opencode":
      // The install script: `~/.opencode/bin`; Homebrew, for apps started from the Finder.
      return [
        p.join(home, ".opencode", "bin", exe("opencode")),
        ...(platform === "darwin" ? ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"] : []),
      ];
    case "gemini":
      // Homebrew (`brew install gemini-cli`), for apps started from the macOS Finder; npm's
      // global folder is on PATH.
      return platform === "darwin" ? ["/opt/homebrew/bin/gemini", "/usr/local/bin/gemini"] : [];
    case "gh":
      if (win) {
        const programFiles = env.ProgramFiles || "C:\\Program Files";
        return [p.join(programFiles, "GitHub CLI", "gh.exe")];
      }
      // Homebrew, for apps started from the macOS Finder with a minimal PATH.
      return platform === "darwin" ? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] : [];
    default:
      return [];
  }
}
