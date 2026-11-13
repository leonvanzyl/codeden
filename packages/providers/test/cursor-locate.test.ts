import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/cursor/adapter";
import { detectCursor, findCursor } from "../src/cursor/detect";
import { clearExecutableCache } from "../src/util/locate";

const fakeAcp = join(import.meta.dirname, "fixtures", "fake-acp", "agent.mjs");
const win = process.platform === "win32";

/** A folder holding an `agent` launcher for `script` (a `.cmd` on Windows, a shell script elsewhere). */
function agentDir(root: string, name: string, script: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (win) {
    writeFileSync(join(dir, "agent.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const file = join(dir, "agent");
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** Another program called `agent`: answers `--version` as `agent 1.2.3` and logs every call. */
function otherAgent(root: string, log: string): string {
  const script = join(root, "other-agent.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("agent 1.2.3");
`,
  );
  return agentDir(root, "other", script);
}

const calls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[])
    : [];

afterEach(() => clearExecutableCache());

describe("finding the Cursor CLI", () => {
  it("never runs another program called `agent` beyond `--version`", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeden-cursor-locate-"));
    const log = join(root, "other.log");
    const locate = { pathEnv: otherAgent(root, log), knownLocations: [] };
    const adapter = new CursorAdapter({ locate, probeTimeoutMs: 10_000 });

    const status = await adapter.detect();
    expect(status.installed).toBe(false);
    // Another program is not a broken Cursor install.
    expect(status.broken ?? []).toEqual([]);
    await adapter.refreshModels();
    await expect(
      adapter.openSession({
        sessionId: "s1",
        role: "agent",
        cwd: root,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      }),
    ).rejects.toThrow(/not installed/);
    // It was found (its `--version` ran) and nothing else ever ran on it.
    expect(calls(log).length).toBeGreaterThan(0);
    expect(calls(log).every((args) => args.length === 1 && args[0] === "--version")).toBe(true);
  });

  it("passes over another `agent` earlier on PATH to Cursor's own", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeden-cursor-locate-"));
    const log = join(root, "other.log");
    const cursor = agentDir(root, "cursor", fakeAcp);
    const locate = { pathEnv: [otherAgent(root, log), cursor].join(delimiter), knownLocations: [] };

    const found = await findCursor({ locate, timeoutMs: 10_000 });
    expect(found.version).toBe("2026.10.22-abc1234");
    expect(found.command?.path.startsWith(cursor)).toBe(true);
    expect(found.broken).toEqual([]);
    const status = await detectCursor({ locate, timeoutMs: 10_000 });
    expect(status).toMatchObject({ installed: true, loggedIn: true });
    expect(calls(log).every((args) => args[0] === "--version")).toBe(true);
  });
});
