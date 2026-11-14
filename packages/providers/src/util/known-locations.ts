import { homedir } from "node:os";
import path from "node:path";

export interface KnownLocationOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The user's home folder (defaults to `os.homedir()`). */
  home?: string;
  /** Read for `CODEX_HOME` and `ProgramFiles` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Where a tool's own installer puts it, checked after PATH (§14). Native installers often
 * leave their folder off PATH (or PATH changed after CodeDen started), so a tool that is
 * installed this way is still found. Unknown tools have none.
 */
export function knownLocations(name: string, opts: KnownLocationOptions = {}): string[] {
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
