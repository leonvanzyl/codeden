import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLoginShellPath } from "../src/main/login-shell-path";
import { rotateLog, ServerProcess } from "../src/main/server-process";
import { serverLog } from "../src/server/log";

const STUCK = resolve(__dirname, "support/stuck-server.mjs");
const dirs: string[] = [];

function stuckServer(log: string[], home = mkdtempSync(join(tmpdir(), "codeden-server-process-"))) {
  dirs.push(home);
  return new ServerProcess({
    entry: STUCK,
    home,
    port: 1,
    fake: true,
    logFile: join(home, "logs", "desktop-server.log"),
    onUpdateCommand: () => {},
    onUnexpectedExit: () => {},
    log: (m) => log.push(m),
  });
}

beforeEach(() => {
  resetLoginShellPath();
  vi.stubEnv("SHELL", join(tmpdir(), "codeden-test-missing-shell"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.STUCK_SERVER_MODE;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ServerProcess.start", () => {
  it.skipIf(process.platform !== "darwin")(
    "passes the macOS login shell's PATH to the server",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "codeden-shell-path-"));
      const server = stuckServer([], home);
      const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
      vi.stubEnv("SHELL", "/bin/zsh");
      vi.stubEnv("ZDOTDIR", home);
      vi.stubEnv("PATH", systemPath);
      vi.stubEnv("STUCK_SERVER_MODE", "record-path");
      writeFileSync(join(home, ".zprofile"), 'export PATH="$ZDOTDIR/homebrew/bin:$PATH"\n');
      writeFileSync(
        join(home, ".zshrc"),
        `if [[ $PATH == "$ZDOTDIR/homebrew/bin:"* ]]; then
        export PATH="$ZDOTDIR/nvm/bin:$PATH"
      fi
      print 'Welcome to zsh'
      `,
      );

      try {
        await server.start();
        const path = readFileSync(join(home, "server-path"), "utf8");
        expect(path.split(":").slice(0, 2)).toEqual([
          join(home, "nvm/bin"),
          join(home, "homebrew/bin"),
        ]);
        expect(path).not.toContain("Welcome to zsh");
        expect(process.env.PATH).toBe(systemPath);
      } finally {
        await server.stop({ stopRunner: false });
      }
    },
  );
});

describe("ServerProcess.stop", () => {
  it("stops a server whose close never finishes", async () => {
    const log: string[] = [];
    const server = stuckServer(log);
    await server.start();
    const started = Date.now();
    await server.stop({ stopRunner: false, timeoutMs: 200, graceMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.pid).toBeUndefined();
    expect(log).toContain("server: did not exit in time; stopping it");
  });

  it.skipIf(process.platform === "win32")(
    "kills a server that also ignores SIGTERM, instead of waiting for it forever",
    async () => {
      process.env.STUCK_SERVER_MODE = "ignore-term";
      const log: string[] = [];
      const server = stuckServer(log);
      await server.start();
      const started = Date.now();
      await server.stop({ stopRunner: false, timeoutMs: 200, graceMs: 300 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(server.pid).toBeUndefined();
      expect(log).toContain("server: still running; killing it");
    },
  );
});

describe("the server log", () => {
  it("is moved aside once it grows past the limit, keeping one old copy", () => {
    const home = mkdtempSync(join(tmpdir(), "codeden-server-log-"));
    dirs.push(home);
    const file = join(home, "desktop-server.log");
    rotateLog(file, 10); // no log yet: nothing happens
    writeFileSync(file, "short\n");
    rotateLog(file, 10);
    expect(readFileSync(file, "utf8")).toBe("short\n");
    writeFileSync(file, "a much longer log\n");
    rotateLog(file, 10);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("a much longer log\n");
  });

  it("writes every server line with a timestamp, without CODEDEN_DEBUG", () => {
    const lines: string[] = [];
    const log = serverLog(
      (line) => lines.push(line),
      () => new Date("2026-11-10T12:00:00.000Z"),
    );
    log("worktree cleanup: could not remove C:\\wt\\demo\\abcd1234");
    expect(lines).toEqual([
      "2026-11-10T12:00:00.000Z [codeden] worktree cleanup: could not remove C:\\wt\\demo\\abcd1234",
    ]);
  });
});
