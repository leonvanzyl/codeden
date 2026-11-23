import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loginShellPath,
  mergeShellPath,
  parseMarkedPath,
  readLoginShellPath,
} from "../src/main/login-shell-path";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Stop the background job a fake profile left running.
    const pidFile = join(dir, "job.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the login shell's PATH", () => {
  const mark = "_CODEDEN_PATH_abc_";

  it("reads only what is printed between the two markers", () => {
    expect(
      parseMarkedPath(`Welcome!\n${mark}\n/opt/homebrew/bin:/usr/bin\n${mark}\nbye`, mark),
    ).toBe("/opt/homebrew/bin:/usr/bin");
    // A missing marker, nothing between them, or no folder at all: keep the PATH as it is.
    expect(parseMarkedPath(`${mark}\n/usr/bin`, mark)).toBeNull();
    expect(parseMarkedPath(`${mark}\n\n${mark}`, mark)).toBeNull();
    expect(parseMarkedPath(`${mark}\nnot a path\n${mark}`, mark)).toBeNull();
    expect(parseMarkedPath("Welcome!", mark)).toBeNull();
  });

  it("merges the shell's folders in its order after the folders only the app has", () => {
    const shell =
      "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    // Started from the Dock: every inherited folder is also the shell's.
    expect(mergeShellPath("/usr/bin:/bin:/usr/sbin:/sbin", shell)).toBe(shell);
    // Started from a terminal with a folder of its own; duplicates, trailing slashes and empty
    // entries are dropped.
    expect(mergeShellPath("/work/venv/bin:/usr/bin/::/bin", `${shell}:/opt/homebrew/bin/`)).toBe(
      `/work/venv/bin:${shell}`,
    );
  });

  it("is only read on macOS", async () => {
    expect(await loginShellPath("/usr/bin", "linux")).toBeUndefined();
    expect(await loginShellPath("/usr/bin", "win32")).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("reading the login shell", () => {
  /** A stand-in for `$SHELL`: runs `profile`, then the `-c` script it was given. */
  function fakeShell(profile: string): { shell: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "codeden-login-shell-"));
    dirs.push(dir);
    const shell = join(dir, "shell");
    writeFileSync(shell, `#!/bin/sh\n${profile}\nexec /bin/sh -c "$4"\n`);
    chmodSync(shell, 0o755);
    return { shell, dir };
  }

  it("takes the PATH as soon as it is printed, past a banner and a background job", async () => {
    // The job keeps the shell's output open: waiting for it to close would hold up the start.
    // Its pid goes next to the fake shell, so `afterEach` can stop it.
    const { shell } = fakeShell(
      'echo "Welcome to the fake shell"\nsleep 60 &\necho $! > "$(dirname "$0")/job.pid"',
    );
    const path = await readLoginShellPath({
      env: { SHELL: shell, PATH: "/fake/brew/bin:/usr/bin:/bin" },
      timeoutMs: 60_000,
    });
    expect(path).toBe("/fake/brew/bin:/usr/bin:/bin");
  });

  it("gives up on a shell that never answers", async () => {
    const { shell } = fakeShell("exec sleep 60");
    expect(
      await readLoginShellPath({ env: { SHELL: shell, PATH: "/usr/bin" }, timeoutMs: 200 }),
    ).toBeNull();
  });

  it("keeps the PATH when the shell can't be started", async () => {
    expect(
      await readLoginShellPath({ env: { SHELL: join(tmpdir(), "codeden-no-such-shell") } }),
    ).toBeNull();
  });
});
