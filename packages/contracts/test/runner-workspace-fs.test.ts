import { describe, expect, it } from "vitest";
import {
  FS_CHUNK_MAX_BYTES,
  FS_LIST_MAX_ENTRIES,
  GitCredential,
  RUNNER_LINK_MAX_LINE_BYTES,
  RunnerCommand,
  RunnerCommandResults,
  TRANSFER_CHUNK_BYTES,
  WORKSPACE_FS_MAX_FRAME_BYTES,
  WorkspaceFsErrorCode,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
}

const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

describe("workspace.prepare clone (remote runners §9.1)", () => {
  it("round-trips a clone with a brokered credential and no repoPath", () => {
    const cmd = roundTrip(RunnerCommand, {
      name: "workspace.prepare",
      sessionId: "s1",
      strategy: "clone",
      remoteUrl: "https://github.com/acme/app.git",
      branch: "codeden/fix-1",
      baseRef: "main",
      depth: 50,
      fetch: true,
      setupCommands: [],
      credential: { scope: "https://github.com", username: "x-access-token", password: "secret" },
    });
    expect(cmd).toMatchObject({ strategy: "clone", depth: 50 });
  });

  it("needs remoteUrl for clone and repoPath for every other strategy", () => {
    const base = { name: "workspace.prepare", sessionId: "s1", setupCommands: [] };
    expect(() => RunnerCommand.parse({ ...base, strategy: "clone" })).toThrow(/remoteUrl/);
    expect(() => RunnerCommand.parse({ ...base, strategy: "worktree" })).toThrow(/repoPath/);
    // Commands from today's servers still parse.
    roundTrip(RunnerCommand, { ...base, strategy: "worktree", repoPath: "/r", path: "/r/wt" });
  });

  it("round-trips git.push with and without a credential", () => {
    roundTrip(RunnerCommand, { name: "git.push", cwd: "/w" });
    roundTrip(RunnerCommand, {
      name: "git.push",
      cwd: "/w",
      branch: "b",
      credential: { scope: "https://github.com", username: "x-access-token", password: "t" },
    });
    expect(() =>
      RunnerCommand.parse({ name: "git.push", cwd: "/w", credential: { username: "u" } }),
    ).toThrow();
  });

  it("scopes a credential to one https origin", () => {
    const credential = (scope: string) => ({ scope, username: "x-access-token", password: "t" });
    expect(GitCredential.parse(credential("https://github.example:8443")).scope).toBe(
      "https://github.example:8443",
    );
    // Missing, not https, with a path, credentials or anything git would read as more config.
    for (const scope of [
      "",
      "http://github.com",
      "https://github.com/acme",
      "https://u:p@github.com",
      "https://github.com.helper=x",
      "https://github.com x",
    ]) {
      expect(() => GitCredential.parse(credential(scope)), scope).toThrow();
    }
    expect(() => GitCredential.parse({ username: "x-access-token", password: "t" })).toThrow();
  });
});

describe("fs.* and transfer.* (remote runners §10)", () => {
  it("round-trips every command and result", () => {
    const root = "/home/agent/.codeden/ws/abcd1234";
    roundTrip(RunnerCommand, { name: "fs.list", root });
    roundTrip(RunnerCommand, { name: "fs.list", root, path: "src", maxEntries: 10 });
    roundTrip(RunnerCommand, { name: "fs.stat", root, path: "a.txt" });
    roundTrip(RunnerCommand, { name: "fs.read", root, path: "a.txt", offset: 4, length: 8 });
    roundTrip(RunnerCommand, {
      name: "fs.write",
      root,
      path: "public/a.png",
      data: b64(10),
      createDirs: true,
    });
    roundTrip(RunnerCommand, { name: "transfer.open", root, path: "big.bin", mode: "read" });
    roundTrip(RunnerCommand, { name: "transfer.read", transferId: "t1" });
    roundTrip(RunnerCommand, { name: "transfer.write", transferId: "t1", data: b64(3) });
    roundTrip(RunnerCommand, { name: "transfer.close", transferId: "t1", commit: true });

    const results = RunnerCommandResults;
    roundTrip(results["fs.list"], {
      entries: [
        { path: "src", kind: "dir" },
        { path: "src/a.ts", kind: "file", sizeBytes: 3 },
      ],
      truncated: false,
    });
    roundTrip(results["fs.stat"], { exists: false });
    roundTrip(results["fs.stat"], {
      exists: true,
      kind: "file",
      sizeBytes: 3,
      mtimeMs: 1_700_000_000_000,
      realPath: "src/a.ts",
    });
    roundTrip(results["fs.read"], { data: b64(3), sizeBytes: 3, eof: true });
    roundTrip(results["fs.write"], { sizeBytes: 3 });
    roundTrip(results["transfer.open"], { transferId: "t1", sizeBytes: 0 });
    roundTrip(results["transfer.read"], { data: "", eof: true });
    roundTrip(results["transfer.write"], { sizeBytes: 3 });
    roundTrip(results["transfer.close"], { committed: false });
  });

  it("caps chunks and refuses data that isn't base64", () => {
    const root = "/w";
    expect(() =>
      RunnerCommand.parse({ name: "fs.read", root, path: "a", length: FS_CHUNK_MAX_BYTES + 1 }),
    ).toThrow();
    expect(() =>
      RunnerCommand.parse({ name: "fs.write", root, path: "a", data: b64(FS_CHUNK_MAX_BYTES + 3) }),
    ).toThrow();
    expect(() =>
      RunnerCommand.parse({
        name: "transfer.write",
        transferId: "t",
        data: b64(TRANSFER_CHUNK_BYTES + 3),
      }),
    ).toThrow();
    expect(() => RunnerCommand.parse({ name: "fs.write", root, path: "a", data: "%%" })).toThrow();
    expect(WorkspaceFsErrorCode.options).toContain("cwd_missing");
  });

  it("keeps the largest command and result within one workspace-file frame", () => {
    // The longest root and path, of characters JSON escapes the most (`\u0001`: 6 bytes each).
    const long = "\u0001".repeat(4096);
    const id = "i".repeat(100);
    const frame = (message: unknown) => Buffer.byteLength(JSON.stringify(message));
    const commands = [
      { name: "fs.write", root: long, path: long, data: b64(FS_CHUNK_MAX_BYTES), createDirs: true },
      { name: "transfer.write", transferId: "t".repeat(100), data: b64(TRANSFER_CHUNK_BYTES) },
    ];
    for (const command of commands) {
      const parsed = RunnerCommand.parse(command);
      expect(frame({ type: "command", id, command: parsed })).toBeLessThan(
        WORKSPACE_FS_MAX_FRAME_BYTES,
      );
    }
    const results = [
      RunnerCommandResults["fs.read"].parse({
        data: b64(FS_CHUNK_MAX_BYTES),
        sizeBytes: Number.MAX_SAFE_INTEGER,
        eof: false,
      }),
      RunnerCommandResults["transfer.read"].parse({ data: b64(TRANSFER_CHUNK_BYTES), eof: true }),
    ];
    for (const result of results) {
      expect(frame({ type: "result", id, ok: true, result })).toBeLessThan(
        WORKSPACE_FS_MAX_FRAME_BYTES,
      );
    }
    // Half the link's line, so file traffic never comes near it.
    expect(WORKSPACE_FS_MAX_FRAME_BYTES * 2).toBe(RUNNER_LINK_MAX_LINE_BYTES);
    // A listing is capped by entries too (and cut off by size on the runner).
    const entries = Array.from({ length: FS_LIST_MAX_ENTRIES + 1 }, (_, i) => ({
      path: `f${i}`,
      kind: "file",
    }));
    expect(() => RunnerCommandResults["fs.list"].parse({ entries, truncated: false })).toThrow();
  });
});

describe("browser.screenshot bytes", () => {
  it("takes no path and returns the PNG inline", () => {
    roundTrip(RunnerCommand, { name: "browser.screenshot", sessionId: "s1" });
    roundTrip(RunnerCommand, { name: "browser.screenshot", sessionId: "s1", path: "/tmp/a.png" });
    roundTrip(RunnerCommandResults["browser.screenshot"], {
      data: b64(20),
      width: 10,
      height: 10,
      bytes: 20,
    });
    roundTrip(RunnerCommandResults["browser.screenshot"], {
      path: "/tmp/a.png",
      width: 10,
      height: 10,
      bytes: 20,
    });
  });
});
