import { readFileSync } from "node:fs";
import type { ResolvedCommand } from "../util/exec";
import { quickLocate } from "../util/locate";
import { shimTarget } from "../util/shim";

/**
 * The native binary behind an npm `.cmd` shim, e.g.
 * `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*`. OpenCode's npm package ships a
 * native executable, so it is launched directly: no `cmd.exe` in between, so closing its
 * stdin and killing it reach OpenCode itself.
 */
export function nativeBehindShim(cmd: ResolvedCommand): ResolvedCommand {
  if (cmd.kind !== "shell-script") return cmd;
  let content: string;
  try {
    content = readFileSync(cmd.path, "utf8");
  } catch {
    return cmd;
  }
  const target = shimTarget(cmd.path, content);
  return target && /\.exe$/i.test(target) ? { kind: "native", path: target } : cmd;
}

/**
 * The `opencode` to launch: PATH first, then its installers' folders (`~/.opencode/bin`,
 * Homebrew), skipping copies the last `--version` check found broken. Looked up every time,
 * since the runner outlives updates and reinstalls. `undefined` when none is found.
 */
export function locateOpenCode(): ResolvedCommand | undefined {
  const found = quickLocate("opencode");
  return found ? nativeBehindShim(found) : undefined;
}
