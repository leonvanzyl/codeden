import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DiskStat, WorkspaceFsError } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInside } from "../src/services/files/path-guard";
import {
  type LocalOutgoingOptions,
  localOutgoingFile,
  remoteOutgoingFile,
} from "../src/services/outgoing-paths";
import type { WorkspaceFs } from "../src/services/workspace-fs/workspace-fs";

// The rule for files an agent sends out by path (`share_to_chat`, `browser_upload`): only from
// the session's own folders, never a secrets file.

let dir: string;
let opts: LocalOutgoingOptions;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "codeden-outgoing-")));
  mkdirSync(join(dir, "wt"));
  mkdirSync(join(dir, "artifacts"));
  opts = { cwd: join(dir, "wt"), artifactsDir: join(dir, "artifacts"), use: "uploaded" };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("localOutgoingFile", () => {
  it("resolves a relative path against the working folder and returns the real file", () => {
    writeFileSync(join(dir, "wt", "data.csv"), "a,b\n");
    expect(localOutgoingFile("data.csv", opts)).toBe(join(dir, "wt", "data.csv"));
    expect(localOutgoingFile(join(dir, "wt", "data.csv"), opts)).toBe(join(dir, "wt", "data.csv"));
  });

  it("refuses missing files and folders", () => {
    expect(() => localOutgoingFile("nope.csv", opts)).toThrow(/File not found: nope\.csv/);
    expect(() => localOutgoingFile(".", opts)).toThrow(/File not found/);
  });

  it("refuses files outside the working folder, the temp folder and the artifacts", () => {
    const outside = fileURLToPath(new URL("../package.json", import.meta.url));
    // Only meaningful when the checkout itself isn't under the temp folder.
    if (isInside(realpathSync.native(tmpdir()), outside)) return;
    expect(() => localOutgoingFile(outside, opts)).toThrow(
      /Only files inside your working directory, the temp folder or your own CodeDen artifacts can be uploaded/,
    );
  });

  it("refuses secrets files, also in the working folder", () => {
    for (const name of [".env", "id_rsa", "server.pem"]) {
      writeFileSync(join(dir, "wt", name), "SECRET=1\n");
      expect(() => localOutgoingFile(name, opts), name).toThrow(/looks like a secrets file/);
    }
    writeFileSync(join(dir, "wt", ".env.example"), "KEY=\n");
    expect(localOutgoingFile(".env.example", opts)).toBe(join(dir, "wt", ".env.example"));
  });
});

/** A remote workspace whose `stat` answers from a table, like a runner would. */
function remoteFs(stats: Record<string, DiskStat | WorkspaceFsError>): WorkspaceFs {
  return {
    root: "/work/repo",
    remote: true,
    stat: async (path) => {
      const answer = stats[path] ?? { exists: false };
      if (answer instanceof WorkspaceFsError) throw answer;
      return answer;
    },
    pathOf: (relative) => `/work/repo/${relative}`,
  } as WorkspaceFs;
}

const file = (realPath: string, kind: "file" | "dir" = "file"): DiskStat => ({
  exists: true,
  kind,
  sizeBytes: 4,
  mtimeMs: 0,
  realPath,
});

describe("remoteOutgoingFile", () => {
  const use = { use: "uploaded" } as const;

  it("returns the file's real path on the runner's machine", async () => {
    const files = remoteFs({ "data.csv": file("fixtures/data.csv") });
    await expect(remoteOutgoingFile(files, "data.csv", use)).resolves.toBe(
      "/work/repo/fixtures/data.csv",
    );
  });

  it("refuses missing files, folders, paths outside the workspace and secrets by any name", async () => {
    const files = remoteFs({
      src: file("src", "dir"),
      "../etc/passwd": new WorkspaceFsError("path_outside_root", "outside"),
      "config.txt": file(".env"),
      ".env": file(".env"),
    });
    await expect(remoteOutgoingFile(files, "gone.csv", use)).rejects.toThrow(/File not found/);
    await expect(remoteOutgoingFile(files, "src", use)).rejects.toThrow(/File not found/);
    await expect(remoteOutgoingFile(files, "../etc/passwd", use)).rejects.toThrow(
      /Only files inside your working directory \(\/work\/repo\) can be uploaded/,
    );
    await expect(remoteOutgoingFile(files, ".env", use)).rejects.toThrow(/secrets file/);
    // A harmless name whose real file is a secret.
    await expect(remoteOutgoingFile(files, "config.txt", use)).rejects.toThrow(/secrets file/);
  });
});
