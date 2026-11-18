import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLoginShellPath,
  mergeShellPath,
  parseMarkedPath,
  readLoginShellPath,
  resetLoginShellPath,
} from "../src/util/login-shell-path";
import { refreshProcessPath } from "../src/util/system-path";

const MINIMAL = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_PATH =
  "/Users/ada/.bun/bin:/opt/homebrew/bin:/Users/ada/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin:/usr/sbin:/sbin";

afterEach(() => resetLoginShellPath());

describe("mergeShellPath", () => {
  it("takes the login shell's PATH as it is over the minimal PATH of a GUI app", () => {
    expect(mergeShellPath(MINIMAL, SHELL_PATH)).toBe(SHELL_PATH);
  });

  it("keeps folders only the process had in front, and drops duplicates", () => {
    const current = "/repo/node_modules/.bin:/usr/bin:/bin";
    expect(mergeShellPath(current, "/opt/homebrew/bin:/usr/bin/:/bin:/opt/homebrew/bin")).toBe(
      "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin/:/bin",
    );
  });
});

describe("parseMarkedPath", () => {
  it("reads only what is between the markers, whatever the startup files print", () => {
    const out = "Welcome!\nnvm: using 24\n_M_\n/a/bin:/usr/bin\n_M_\nbye\n";
    expect(parseMarkedPath(out, "_M_")).toBe("/a/bin:/usr/bin");
    expect(parseMarkedPath("_M_\n/a/bin", "_M_")).toBeNull();
    expect(parseMarkedPath("_M_\n\n_M_", "_M_")).toBeNull();
    expect(parseMarkedPath("nothing", "_M_")).toBeNull();
  });
});

describe("applyLoginShellPath", () => {
  it("merges the shell's PATH on macOS and Linux and lets re-checks read it again", async () => {
    const env: NodeJS.ProcessEnv = { PATH: MINIMAL };
    let shellPath = SHELL_PATH;
    const read = vi.fn(async () => shellPath);
    const added = await applyLoginShellPath({ platform: "darwin", env, read });
    expect(added).toEqual([
      "/Users/ada/.bun/bin",
      "/opt/homebrew/bin",
      "/Users/ada/.nvm/versions/node/v24.1.0/bin",
    ]);
    expect(env.PATH).toBe(SHELL_PATH);

    // A tool installed later (its folder added in the user's shell config): within a minute a
    // re-check reuses the last read; a fresh read finds it.
    shellPath = `/Users/ada/Library/pnpm:${SHELL_PATH}`;
    expect(await refreshProcessPath({ platform: "darwin", env })).toEqual([]);
    const later = await applyLoginShellPath({ platform: "darwin", env, read });
    expect(later).toEqual(["/Users/ada/Library/pnpm"]);
  });

  it("leaves PATH alone on Windows, when turned off, and when the shell can't be read", async () => {
    const read = vi.fn(async () => SHELL_PATH);
    const env: NodeJS.ProcessEnv = { PATH: MINIMAL };
    expect(await applyLoginShellPath({ platform: "win32", env, read })).toEqual([]);
    expect(
      await applyLoginShellPath({
        platform: "darwin",
        env: { ...env, CODEDEN_LOGIN_SHELL: "0" },
        read,
      }),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await applyLoginShellPath({ platform: "linux", env, read: async () => null })).toEqual(
      [],
    );
    expect(env.PATH).toBe(MINIMAL);
  });

  it("is not turned on by a re-check alone (tests and library users keep their PATH)", async () => {
    const env: NodeJS.ProcessEnv = { PATH: MINIMAL };
    expect(await refreshProcessPath({ platform: "linux", env })).toEqual([]);
    expect(env.PATH).toBe(MINIMAL);
  });
});

describe.runIf(process.platform !== "win32")("readLoginShellPath", () => {
  const fakeShell = (body: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "codeden-shell-")), "fake-shell");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("runs $SHELL as an interactive login shell and reads PATH between the markers", async () => {
    // Prints noise like a chatty shell config, then runs the command it was given (`-c`).
    const shell = fakeShell(
      'echo "args: $1 $2 $3"\necho "noise"\nPATH=/from/shell/bin:/usr/bin:/bin\nexport PATH\neval "$4"',
    );
    const value = await readLoginShellPath({ env: { SHELL: shell, PATH: MINIMAL } });
    expect(value).toBe("/from/shell/bin:/usr/bin:/bin");
  });

  it("gives up on a shell that hangs, and on one that prints no PATH", async () => {
    const hangs = fakeShell("sleep 30");
    const started = Date.now();
    expect(await readLoginShellPath({ env: { SHELL: hangs }, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await readLoginShellPath({ env: { SHELL: fakeShell("exit 1") } })).toBeNull();
  });
});
