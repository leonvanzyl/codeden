import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { listSessionFiles, readSessionFile } from "../src/services/files/session-files";
import { LocalWorkspaceFs } from "../src/services/workspace-fs/local";

let dir: string;
let home: string;
let files: LocalWorkspaceFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-session-files-"));
  home = mkdtempSync(join(tmpdir(), "codeden-session-files-home-"));
  files = new LocalWorkspaceFs(dir, home);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "src", ".git"), "gitdir: elsewhere\n");
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "blob.bin"), Buffer.from([1, 0, 2]));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("session files", () => {
  it("lists folders first and skips .git and node_modules", async () => {
    const list = await listSessionFiles(files);
    expect(list.entries.map((e) => e.path)).toEqual([
      "src",
      "src/blob.bin",
      "src/index.ts",
      "README.md",
    ]);
    expect(list.truncated).toBe(false);
  });

  it("reads text files, flags binaries and stays inside the folder", async () => {
    expect(await readSessionFile(files, "src/index.ts")).toMatchObject({
      content: "export {};\n",
      binary: false,
    });
    expect((await readSessionFile(files, "src/blob.bin")).binary).toBe(true);
    const code = async (run: () => Promise<unknown>) =>
      run().then(
        () => "ok",
        (error: unknown) => (error instanceof ServiceError ? error.code : String(error)),
      );
    expect(await code(() => readSessionFile(files, "../outside.txt"))).toBe("path_outside_root");
    expect(await code(() => readSessionFile(files, "missing.txt"))).toBe("file_not_found");
    const gone = new LocalWorkspaceFs(join(dir, "gone"), home);
    expect(await code(() => listSessionFiles(gone))).toBe("folder_not_found");
  });
});
