import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ResolvedCommand, type ResolveOptions, resolveExecutable } from "../util/exec";

/**
 * Where OpenCode's installers put `opencode` when it is not on PATH: the install script
 * (`~/.opencode/bin`), npm's default global prefix on Windows, `~/.local/bin`, and Homebrew.
 */
export function openCodeKnownLocations(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const appData = env.APPDATA ?? p.join(home, "AppData", "Roaming");
    return [
      p.join(home, ".opencode", "bin", "opencode.exe"),
      p.join(appData, "npm", "opencode.cmd"),
    ];
  }
  return [
    p.join(home, ".opencode", "bin", "opencode"),
    p.join(home, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
}

/**
 * The native binary behind an npm `.cmd` shim, e.g.
 * `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*`. OpenCode's npm package ships a
 * native executable, so it is launched directly: no `cmd.exe` in between, and killing it
 * kills OpenCode itself.
 */
export function exeFromCmdShim(shimPath: string, content?: string): string | undefined {
  let text = content;
  if (text === undefined) {
    try {
      text = readFileSync(shimPath, "utf8");
    } catch {
      return undefined;
    }
  }
  const match = /"%~?dp0%?\\?([^"%]+?\.exe)"/i.exec(text);
  if (!match?.[1]) return undefined;
  const exe = path.win32.resolve(path.win32.dirname(shimPath), match[1]);
  if (content === undefined && !existsSync(exe)) return undefined;
  return exe;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Prefer the native executable over a shim that only forwards to it. */
function unwrap(cmd: ResolvedCommand): ResolvedCommand {
  if (cmd.kind !== "shell-script") return cmd;
  const exe = exeFromCmdShim(cmd.path);
  return exe ? { kind: "native", path: exe } : cmd;
}

/**
 * Find `opencode`: PATH first, then the installers' default folders (a runner started from a
 * desktop shortcut may not see a PATH change the installer made). `undefined` when absent.
 */
export function locateOpenCode(
  opts: ResolveOptions & { home?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedCommand | undefined {
  const onPath = resolveExecutable("opencode", opts);
  if (onPath) return unwrap(onPath);
  const platform = opts.platform ?? process.platform;
  for (const candidate of openCodeKnownLocations(platform, opts.home, opts.env)) {
    if (!isFile(candidate)) continue;
    const found = resolveExecutable(candidate, opts);
    if (found) return unwrap(found);
  }
  return undefined;
}
