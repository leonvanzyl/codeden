import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ServiceError } from "../src/services/errors";
import { resolveTool, runTool } from "../src/services/exec";
import {
  detectPackageManager,
  normalizeCloneUrl,
  parseGitHubRemote,
} from "../src/services/projects/detect";
import { ProjectService, redactUrls, slugify } from "../src/services/projects/project-service";
import { removeTree } from "./support/remove-tree";

describe("project detection helpers", () => {
  it("parses GitHub remotes in every common form", () => {
    for (const url of [
      "https://github.com/octo/app.git",
      "https://github.com/octo/app",
      "git@github.com:octo/app.git",
      "ssh://git@github.com/octo/app.git",
    ]) {
      expect(parseGitHubRemote(url)).toEqual({ owner: "octo", repo: "app" });
    }
    expect(parseGitHubRemote("https://gitlab.com/octo/app.git")).toBeNull();
  });

  it("validates clone sources", () => {
    expect(normalizeCloneUrl("octo/app")).toEqual({
      url: "https://github.com/octo/app.git",
      name: "app",
    });
    expect(normalizeCloneUrl("git@github.com:octo/app.git").name).toBe("app");
    for (const bad of ["--upload-pack=evil", "ftp://x/y", "a b", ""]) {
      expect(() => normalizeCloneUrl(bad)).toThrow(ServiceError);
    }
  });

  it("slugs names and redacts credentials", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("***")).toBe("project");
    expect(redactUrls("fatal: https://me:tok@github.com/x")).toBe(
      "fatal: https://***@github.com/x",
    );
  });
});

let dir: string;
let database: Database;
let service: ProjectService;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-projects-"));
  database = openDatabase(join(dir, "codeden.db"));
  service = new ProjectService({
    db: database.db,
    store: new EventStore(database.db),
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

describe("ProjectService", () => {
  it("adds plain folders as local projects with unique slugs", async () => {
    mkdirSync(join(dir, "a", "app"), { recursive: true });
    mkdirSync(join(dir, "b", "app"), { recursive: true });
    writeFileSync(join(dir, "a", "app", "package.json"), '{"packageManager":"yarn@4.0.0"}');
    const one = await service.create({ source: { type: "local", path: join(dir, "a", "app") } });
    const two = await service.create({ source: { type: "local", path: join(dir, "b", "app") } });
    expect(one.project).toMatchObject({ kind: "local", slug: "app", defaultBranch: null });
    expect(one.detected).toMatchObject({ isGitRepo: false, packageManager: "yarn" });
    expect(two.project.slug).toBe("app-2");
    expect(detectPackageManager(join(dir, "b", "app"))).toBeNull();

    service.archive(one.project.id);
    expect(service.list().map((p) => p.id)).toEqual([two.project.id]);
    const restored = await service.create({
      source: { type: "local", path: join(dir, "a", "app") },
    });
    expect(restored.project.id).toBe(one.project.id);
    expect(service.update(two.project.id, { name: "Renamed" }).name).toBe("Renamed");
  });

  it("clones a repository and detects its GitHub remote", async () => {
    const origin = join(dir, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "trunk");
    git(origin, "config", "user.email", "t@e.st");
    git(origin, "config", "user.name", "T");
    writeFileSync(join(origin, "README.md"), "hi");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "init");

    const created = await service.create({
      source: { type: "clone", url: pathToFileURL(origin).href },
    });
    expect(created.project.path).toBe(join(dir, "clones", "origin"));
    expect(created.project).toMatchObject({ kind: "local", defaultBranch: "trunk" });
    expect(existsSync(join(dir, "clones", "origin", "README.md"))).toBe(true);

    // A GitHub-looking origin makes it a github project.
    git(created.project.path, "remote", "set-url", "origin", "https://github.com/octo/demo.git");
    service.archive(created.project.id);
    const again = await service.create({ source: { type: "local", path: created.project.path } });
    expect(again.detected.github).toMatchObject({ owner: "octo", repo: "demo" });

    await expect(
      service.create({ source: { type: "clone", url: pathToFileURL(origin).href } }),
    ).rejects.toMatchObject({ code: "destination_exists" });
  });
});

describe("runTool", () => {
  it("reports missing executables", async () => {
    const result = await runTool("definitely-not-a-real-tool-xyz", []);
    expect(result).toMatchObject({ notFound: true, code: null });
  });

  it("finds a tool in its known install locations when PATH lacks it, like the setup checks", () => {
    // An app started from the Dock: gh is in Homebrew's folder, which is not on PATH.
    const win = process.platform === "win32";
    const brew = join(dir, "homebrew-bin");
    const onPath = join(dir, "on-path");
    mkdirSync(brew);
    mkdirSync(onPath);
    const tool = (folder: string) => {
      const file = join(folder, win ? "gh.exe" : "gh");
      writeFileSync(file, "");
      chmodSync(file, 0o755);
      return file;
    };
    const known = () => [join(dir, "missing", "gh"), tool(brew)];
    expect(resolveTool("gh", { PATH: join(dir, "empty") }, known)).toBe(
      join(brew, win ? "gh.exe" : "gh"),
    );
    expect(resolveTool("gh", { PATH: onPath, PATHEXT: ".EXE" }, () => [])).toBeNull();
    // A copy on PATH still wins, and paths are never looked up elsewhere.
    const first = tool(onPath);
    expect(resolveTool("gh", { PATH: onPath, PATHEXT: ".EXE" }, known)).toBe(first);
    expect(resolveTool(join(dir, "nope", "gh"), { PATH: "" }, known)).toBeNull();
  });

  it.runIf(process.platform === "win32")("runs .cmd shims on Windows", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "hello.cmd"), "@echo off\r\necho hi %1 %2\r\n");
    const result = await runTool("hello", ["there", "--flag"], { env: { PATH: bin } });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim()).toBe("hi there --flag");
    const unsafe = await runTool("hello", ["a&calc"], { env: { PATH: bin } });
    expect(unsafe.code).toBeNull();
    expect(unsafe.stderr).toContain("Unsafe argument");
  });
});
