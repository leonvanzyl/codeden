import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FS_CHUNK_MAX_BYTES, TRANSFER_CHUNK_BYTES } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFsHost } from "../src/workspace/fs";
import { removeDir, tempDir, write } from "./helpers";

/**
 * `fs.*` and `transfer.*` (`docs/remote-runners.md` §10) on the runner. The guard table that
 * compares them with the server's own disk is `apps/server/test/workspace-fs-parity.test.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

function setup() {
  const home = tempDir("codeden-fs-home-");
  const root = tempDir("codeden-fs-ws-");
  dirs.push(home, root);
  return { home, root, files: new WorkspaceFsHost(home) };
}

describe("fs.*", () => {
  it("lists, stats, reads ranges and writes atomically", () => {
    const { root, files } = setup();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "node_modules/x/index.js", "skipped");
    const list = files.execute({ name: "fs.list", root });
    expect(list).toEqual({
      entries: [
        { path: "src", kind: "dir" },
        { path: "src/a.ts", kind: "file", sizeBytes: 20 },
      ],
      truncated: false,
    });
    expect(files.execute({ name: "fs.stat", root, path: "src/a.ts" })).toMatchObject({
      exists: true,
      kind: "file",
      sizeBytes: 20,
      realPath: "src/a.ts",
    });
    expect(files.execute({ name: "fs.stat", root, path: "nope.txt" })).toEqual({ exists: false });
    const part = files.execute({ name: "fs.read", root, path: "src/a.ts", offset: 7, length: 5 });
    expect(Buffer.from(part.data, "base64").toString()).toBe("const");
    expect(part).toMatchObject({ sizeBytes: 20, eof: false });

    const data = Buffer.from("png bytes").toString("base64");
    expect(
      files.execute({ name: "fs.write", root, path: "public/hero.png", data, createDirs: true }),
    ).toEqual({ sizeBytes: 9 });
    expect(readFileSync(join(root, "public", "hero.png"), "utf8")).toBe("png bytes");
    // No temp file is left next to it.
    expect(readdirSync(join(root, "public"))).toEqual(["hero.png"]);
  });

  it("refuses escapes, a missing root and CodeDen's own folders", () => {
    const { home, root, files } = setup();
    const code = (run: () => unknown) => {
      try {
        run();
        return "ok";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(code(() => files.execute({ name: "fs.read", root, path: "../outside" }))).toBe(
      "path_outside_root",
    );
    expect(code(() => files.execute({ name: "fs.list", root: join(root, "gone") }))).toBe(
      "cwd_missing",
    );
    write(home, "runner/runner.json", "{}");
    expect(code(() => files.execute({ name: "fs.list", root: join(home, "runner") }))).toBe(
      "root_invalid",
    );
    expect(code(() => files.execute({ name: "fs.list", root: home }))).toBe("root_invalid");
    expect(code(() => files.execute({ name: "fs.list", root: "relative/root" }))).toBe(
      "root_invalid",
    );
  });
});

describe("transfer.*", () => {
  it("reads a file larger than one fs.read in chunks, byte for byte", () => {
    const { root, files } = setup();
    const big = randomBytes(FS_CHUNK_MAX_BYTES + 123_457);
    write(root, "big.bin", big);
    const { transferId, sizeBytes } = files.execute({
      name: "transfer.open",
      root,
      path: "big.bin",
      mode: "read",
    });
    expect(sizeBytes).toBe(big.length);
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = files.execute({ name: "transfer.read", transferId });
      const bytes = Buffer.from(chunk.data, "base64");
      expect(bytes.length).toBeLessThanOrEqual(TRANSFER_CHUNK_BYTES);
      chunks.push(bytes);
      if (chunk.eof) break;
    }
    expect(chunks.length).toBe(Math.ceil(big.length / TRANSFER_CHUNK_BYTES));
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    expect(files.execute({ name: "transfer.close", transferId })).toEqual({ committed: false });
    expect(() => files.execute({ name: "transfer.read", transferId })).toThrow(
      expect.objectContaining({ code: "transfer_not_found" }),
    );
  });

  it("lands a write only on commit, and an uncommitted write leaves no file", () => {
    const { root, files } = setup();
    const send = (path: string, commit: boolean) => {
      const { transferId } = files.execute({ name: "transfer.open", root, path, mode: "write" });
      for (const part of ["first ", "second"]) {
        const data = Buffer.from(part).toString("base64");
        files.execute({ name: "transfer.write", transferId, data });
      }
      // Nothing at the target until the commit.
      expect(existsSync(join(root, path))).toBe(false);
      return files.execute({ name: "transfer.close", transferId, commit });
    };
    expect(send("kept.txt", true)).toEqual({ committed: true });
    expect(readFileSync(join(root, "kept.txt"), "utf8")).toBe("first second");
    expect(send("dropped.txt", false)).toEqual({ committed: false });
    expect(readdirSync(root)).toEqual(["kept.txt"]);
  });

  it("closes a transfer that stays idle, discarding its write", () => {
    vi.useFakeTimers();
    const { root, files } = setup();
    const { transferId } = files.execute({
      name: "transfer.open",
      root,
      path: "late.txt",
      mode: "write",
    });
    vi.advanceTimersByTime(61_000);
    expect(() => files.execute({ name: "transfer.close", transferId, commit: true })).toThrow(
      expect.objectContaining({ code: "transfer_not_found" }),
    );
    expect(readdirSync(root)).toEqual([]);
  });
});
