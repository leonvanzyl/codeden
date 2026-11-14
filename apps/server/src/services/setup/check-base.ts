import type { SetupCheck, SetupCommand, SetupToolId } from "@codeden/contracts";
import { cursorInstallCommand, GEMINI_INSTALL_COMMAND } from "@codeden/providers";
import type { Exec } from "../exec";
import type { BrowserProbe } from "./browsers";
import type { Locate } from "./tool-lookup";

export const MIN_NODE_MAJOR = 24;

const LABELS: Record<SetupToolId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  gh: "GitHub CLI",
  git: "git",
  browser: "Browser",
  node: "Node.js",
};

/** The one command that installs (or updates) a tool on this platform. */
export function installFix(id: SetupToolId, platform: NodeJS.Platform): SetupCommand {
  switch (id) {
    case "claude":
      return { kind: "install", command: "npm install -g @anthropic-ai/claude-code" };
    case "codex":
      return { kind: "install", command: "npm install -g @openai/codex" };
    case "opencode":
      return {
        kind: "install",
        command: "npm install -g @opencode/cli",
        url: "https://opencode.ai/docs",
      };
    case "cursor":
      return {
        kind: "install",
        command: cursorInstallCommand(platform),
        url: "https://cursor.com/docs/cli/installation",
      };
    case "gemini":
      return { kind: "install", command: GEMINI_INSTALL_COMMAND, url: "https://geminicli.com" };
    case "gh":
      return {
        kind: "install",
        command:
          platform === "win32"
            ? "winget install --id GitHub.cli"
            : platform === "darwin"
              ? "brew install gh"
              : "See https://github.com/cli/cli#installation",
        url: "https://cli.github.com",
      };
    case "git":
      return {
        kind: "install",
        command:
          platform === "win32"
            ? "winget install --id Git.Git"
            : platform === "darwin"
              ? "xcode-select --install"
              : "Install git with your package manager",
        url: "https://git-scm.com/downloads",
      };
    case "browser":
      return {
        kind: "install",
        command: "Install Microsoft Edge or Google Chrome",
        url: "https://www.google.com/chrome/",
      };
    case "node":
      return {
        kind: "upgrade",
        command: `Install Node.js ${MIN_NODE_MAJOR} or newer`,
        url: "https://nodejs.org",
      };
  }
}

/** A check's fields before anything is known: not installed, not signed in. */
export function base(id: SetupToolId): Omit<SetupCheck, "state" | "message" | "durationMs"> {
  return {
    id,
    label: LABELS[id],
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    fix: null,
  };
}

export type CheckResult = Omit<SetupCheck, "durationMs">;

export interface CheckEnv {
  exec: Exec;
  /** Finds a working copy of a tool (PATH, then known install locations). */
  locate: Locate;
  /** The shell of the setup terminal, for quoting sign-in commands. */
  shell: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  now: number;
  browserProbe?: Partial<BrowserProbe>;
  /** The user's home folder, where CLIs keep their settings (default: `os.homedir()`). */
  userHome?: string;
  /** Read for which login variables are set, never their values (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}
