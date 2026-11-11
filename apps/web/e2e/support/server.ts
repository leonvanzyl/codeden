import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sweepProcesses } from "./process-sweep";

export interface E2eServer {
  url: string;
  launchUrl: string;
  token: string;
  home: string;
  /**
   * The folder the server treats as `~` for agent config (`~/.claude`, `~/.codex`): a temp
   * folder, so tests never touch the real user's files. Seeded with `~/.claude/CLAUDE.md`.
   */
  userHome: string;
  /** A fresh git repo the tests add as a project. */
  repo: string;
  stop(): Promise<void>;
}

const here = import.meta.dirname;

/** The seeded global Claude memory file in the temp user home. */
export const E2E_CLAUDE_MD = "# Global rules\n\n- Keep answers short.\n";
const repoRoot = resolve(here, "../../../..");

/** A small committed git repo in a temp folder. */
export function makeTempRepo(parent: string): string {
  const repo = join(parent, "demo-repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  git("config", "user.email", "e2e@codeden.test");
  git("config", "user.name", "CodeDen E2E");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "# Demo repo\n\nUsed by the CodeDen end-to-end tests.\n");
  writeFileSync(join(repo, "package.json"), '{ "name": "demo-repo", "version": "1.0.0" }\n');
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  return repo;
}

export interface E2eServerOptions {
  /** Load the real Claude Code, Codex and OpenCode adapters. */
  builtin?: boolean;
  /**
   * Adjust the server's environment, e.g. a PATH with fake CLIs. Gets the run's temp folder
   * (removed on stop) and the environment so far.
   */
  env?: (base: string, env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /**
   * Keep the server's PATH as given: no refresh from the Windows registry before setup
   * checks, so tools installed on this machine stay out of a test that pins PATH.
   */
  pinPath?: boolean;
}

/**
 * Start a real server + runner on a free port with an isolated `CODEDEN_HOME`, the Fake
 * provider on and the real adapters off (unless `builtin`). Resolves once it is listening.
 */
export async function startE2eServer(opts: E2eServerOptions = {}): Promise<E2eServer> {
  // Canonical path: the server stores realpaths, and CI temp dirs are 8.3 short names on
  // Windows and a symlink on macOS, so the specs could not find the project they added.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "codeden-e2e-")));
  const home = join(base, "home");
  const repo = makeTempRepo(base);
  const userHome = join(base, "user-home");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  writeFileSync(join(userHome, ".claude", "CLAUDE.md"), E2E_CLAUDE_MD);
  const baseEnv = {
    ...process.env,
    CODEDEN_HOME: home,
    CODEDEN_UPDATE_CHECK: "0",
    // A real OpenCode on this machine (the setup check) never sees the user's own data.
    XDG_DATA_HOME: join(base, "xdg", "data"),
    XDG_CONFIG_HOME: join(base, "xdg", "config"),
    XDG_STATE_HOME: join(base, "xdg", "state"),
    XDG_CACHE_HOME: join(base, "xdg", "cache"),
  };
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(here, "start-server.ts"),
      "--home",
      home,
      "--user-home",
      userHome,
      "--port",
      "0",
      "--exit-with-stdin",
      ...(opts.builtin ? ["--builtin"] : []),
      ...(opts.pinPath ? ["--no-path-refresh"] : []),
    ],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? opts.env(base, baseEnv) : baseEnv,
    },
  );
  let log = "";
  const ready = await new Promise<{ url: string; launchUrl: string; token: string }>(
    (resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not start in time:\n${log}`)),
        90_000,
      );
      const onData = (chunk: Buffer) => {
        log += chunk.toString();
        const line = log.split(/\r?\n/).find((l) => l.startsWith("CODEDEN_E2E_READY "));
        if (!line) return;
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice("CODEDEN_E2E_READY ".length)));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (c: Buffer) => {
        log += c.toString();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (${code}):\n${log}`));
      });
    },
  );
  if (process.env.CODEDEN_E2E_LOG) child.stdout?.pipe(process.stdout);

  return {
    ...ready,
    home,
    userHome,
    repo,
    async stop() {
      await fetch(`${ready.url}/api/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" },
        body: JSON.stringify({ stopRunner: true }),
      }).catch(() => undefined);
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        const timer = setTimeout(() => {
          child.kill();
          done();
        }, 15_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
      // Backstop: nothing started from this run's temp folder (runner, terminals) survives it.
      await sweepProcesses(base, 5_000);
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // Windows may still hold a handle on the worktree; the temp folder is cleaned later.
      }
    },
  };
}
