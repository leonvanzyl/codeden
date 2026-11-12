import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve the data directory (§6): explicit value, then `CODEDEN_HOME`, then `~/.codeden`.
 * Two copies can run side by side with different homes and ports.
 */
export function resolveHome(explicit?: string): string {
  const fromEnv = process.env.CODEDEN_HOME;
  if (explicit) return resolve(explicit);
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), ".codeden");
}

/** Well-known paths inside the data directory. */
export function homePaths(home: string) {
  return {
    home,
    db: join(home, "codeden.db"),
    settings: join(home, "settings.json"),
    token: join(home, "install-token"),
    /** Network access switch, password hash and remote sessions (§15.1). */
    remoteAccess: join(home, "remote-access.json"),
    /** Failed remote sign-ins (address and time, never the password). */
    remoteAccessLog: join(home, "logs", "remote-access.log"),
    serverLock: join(home, "server.json"),
    runnerDir: join(home, "runner"),
    runnerLock: join(home, "runner", "runner.json"),
    worktrees: join(home, "wt"),
    artifacts: join(home, "artifacts"),
    logs: join(home, "logs"),
    /** The orchestrator's working directory (§8.1). */
    orchestrator: join(home, "orchestrator"),
    /** Copies of config files taken before the editors overwrite them (§12.4). */
    backups: join(home, "backups"),
    /** Hooks switched off on the Agents page, until they are enabled again (§12.4). */
    disabledHooks: join(home, "agent-config", "disabled-hooks.json"),
    /** Dependencies installed on demand, e.g. Claude Code support (§14). */
    deps: join(home, "deps"),
    /** Models downloaded on demand, e.g. local Whisper for dictation (§11.3). */
    models: join(home, "models"),
  };
}
export type HomePaths = ReturnType<typeof homePaths>;

/** Create the data directory layout if missing. */
export function ensureHome(home: string): HomePaths {
  const paths = homePaths(home);
  for (const dir of [paths.home, paths.runnerDir, paths.worktrees, paths.artifacts, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
