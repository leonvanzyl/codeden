import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpRepository,
  nextVersion,
  releaseChangelog,
  setPackageVersion,
  setSourceVersion,
} from "./bump-version.mjs";
import { UNRELEASED_POINTER } from "./changes.mjs";

describe("nextVersion", () => {
  it("bumps patch, minor and major", () => {
    expect(nextVersion("0.4.0", "patch")).toBe("0.4.1");
    expect(nextVersion("0.4.9", "minor")).toBe("0.5.0");
    expect(nextVersion("0.4.9", "major")).toBe("1.0.0");
  });

  it("rejects unknown bumps and pre-release versions", () => {
    expect(() => nextVersion("0.4.0", "dry-run")).toThrow(/Unknown bump/);
    expect(() => nextVersion("0.4.0-beta.1", "patch")).toThrow(/x\.y\.z/);
  });
});

describe("file edits", () => {
  it("replaces only the version field of a package.json", () => {
    const text = '{\n  "name": "codeden",\n  "version": "0.4.0",\n  "dependencies": {}\n}\n';
    expect(setPackageVersion(text, "0.4.1")).toBe(text.replace("0.4.0", "0.4.1"));
  });

  it("replaces SOURCE_VERSION", () => {
    const text = 'export const SOURCE_VERSION = "0.4.0";\nexport const X = "0.4.0";\n';
    expect(setSourceVersion(text, "0.4.1")).toBe(
      'export const SOURCE_VERSION = "0.4.1";\nexport const X = "0.4.0";\n',
    );
  });

  const unreleased = `# Changelog\n\n## [Unreleased]\n\n${UNRELEASED_POINTER}\n\n`;

  it("adds the notes as the new version below the [Unreleased] pointer", () => {
    const text = `${unreleased}## [0.4.0] - 2026-11-08\n\n- Old.\n`;
    expect(releaseChangelog(text, "0.4.1", "2026-11-09", "### Fixed\n\n- A bug.")).toBe(
      `${unreleased}## [0.4.1] - 2026-11-09\n\n### Fixed\n\n- A bug.\n\n## [0.4.0] - 2026-11-08\n\n- Old.\n`,
    );
  });

  it("adds the pointer to an empty [Unreleased] and handles a first release", () => {
    expect(
      releaseChangelog("# Changelog\n\n## [Unreleased]\n", "0.1.0", "2026-11-09", "- A."),
    ).toBe(`${unreleased}## [0.1.0] - 2026-11-09\n\n- A.\n`);
  });

  it("refuses notes written under [Unreleased] instead of dropping them", () => {
    const text = `${unreleased}### Fixed\n\n- A bug.\n\n## [0.4.0] - 2026-11-08\n`;
    expect(() => releaseChangelog(text, "0.4.1", "2026-11-09", "- B.")).toThrow(
      /notes under ## \[Unreleased\]; move them into a fragment in changes\//,
    );
  });
});

describe("bumpRepository", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const changelog = `# Changelog\n\n## [Unreleased]\n\n${UNRELEASED_POINTER}\n\n## [0.4.0] - 2026-11-08\n\n- Old.\n`;
  const read = (path) => readFileSync(join(root, path), "utf8");

  function makeRepo(cli, desktop, fragments = {}) {
    root = mkdtempSync(join(tmpdir(), "codeden-bump-"));
    for (const dir of ["apps/cli", "apps/desktop", "packages/contracts/src", "changes"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "apps/cli/package.json"), `{\n  "version": "${cli}"\n}\n`);
    writeFileSync(join(root, "apps/desktop/package.json"), `{\n  "version": "${desktop}"\n}\n`);
    writeFileSync(
      join(root, "packages/contracts/src/version.ts"),
      `export const SOURCE_VERSION = "${cli}";\n`,
    );
    writeFileSync(join(root, "CHANGELOG.md"), changelog);
    writeFileSync(join(root, "changes/README.md"), "# Changelog fragments\n");
    for (const [name, [section, body]] of Object.entries(fragments)) {
      writeFileSync(join(root, "changes", name), `---\nsection: ${section}\n---\n\n${body}\n`);
    }
  }

  const sample = {
    "80-fix.md": ["fixed", "- **Fixed.** B."],
    "75-new.md": ["added", "- **New.** A."],
    "77-more.md": ["added", "- **More.** C."],
  };
  const assembled = "### Added\n\n- **New.** A.\n- **More.** C.\n\n### Fixed\n\n- **Fixed.** B.";

  /** The fixture as a git repository with every file staged (no commit, so no identity needed). */
  function makeGitRepo(fragments) {
    makeRepo("0.4.0", "0.4.0", fragments);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "--all"], { cwd: root });
  }
  const gitIndex = () =>
    execFileSync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8" });
  const snapshot = () =>
    [
      "apps/cli/package.json",
      "apps/desktop/package.json",
      "packages/contracts/src/version.ts",
      "CHANGELOG.md",
    ].map(read);
  const bumpScript = fileURLToPath(new URL("./bump-version.mjs", import.meta.url));
  const runCli = (...args) =>
    execFileSync(process.execPath, [bumpScript, ...args], { encoding: "utf8" });

  it("writes the new version everywhere and turns the fragments into its section", () => {
    makeRepo("0.4.0", "0.4.0", sample);
    expect(bumpRepository(root, "minor", "2026-11-09")).toEqual({
      version: "0.5.0",
      date: "2026-11-09",
      notes: assembled,
      fragments: ["changes/75-new.md", "changes/77-more.md", "changes/80-fix.md"],
    });
    expect(JSON.parse(read("apps/cli/package.json")).version).toBe("0.5.0");
    expect(JSON.parse(read("apps/desktop/package.json")).version).toBe("0.5.0");
    expect(read("packages/contracts/src/version.ts")).toContain('"0.5.0"');
    expect(read("CHANGELOG.md")).toBe(
      changelog.replace("## [0.4.0]", `## [0.5.0] - 2026-11-09\n\n${assembled}\n\n## [0.4.0]`),
    );
    expect(readdirSync(join(root, "changes"))).toEqual(["README.md"]);
  });

  it("is a maintenance release without fragments", () => {
    makeRepo("0.4.0", "0.4.0");
    bumpRepository(root, "patch", "2026-11-09");
    expect(read("CHANGELOG.md")).toContain("## [0.4.1] - 2026-11-09\n\nMaintenance release.\n");
  });

  it("changes no file and no git index entry on a dry run, and keeps the given date", () => {
    makeGitRepo(sample);
    const [files, index] = [snapshot(), gitIndex()];
    const result = bumpRepository(root, "patch", "2000-01-02", { dryRun: true });
    expect(result).toEqual({
      version: "0.4.1",
      date: "2000-01-02",
      notes: assembled,
      fragments: ["changes/75-new.md", "changes/77-more.md", "changes/80-fix.md"],
    });
    expect(snapshot()).toEqual(files);
    expect(gitIndex()).toBe(index);
    expect(readdirSync(join(root, "changes"))).toHaveLength(4);
  });

  it("refuses options in the date's place before writing anything", () => {
    makeRepo("0.4.0", "0.4.0", sample);
    const files = snapshot();
    expect(() => bumpRepository(root, "patch", { dryRun: true })).toThrow(
      /date must be YYYY-MM-DD \(got \{"dryRun":true\}\); options go fourth/,
    );
    expect(() => bumpRepository(root, "patch", "9 Nov 2026")).toThrow(/date must be YYYY-MM-DD/);
    expect(snapshot()).toEqual(files);
    expect(readdirSync(join(root, "changes"))).toHaveLength(4);
  });

  it("from the command line: --dry-run changes nothing; a release prints only the version and stages the removals", () => {
    makeGitRepo(sample);
    const [files, index] = [snapshot(), gitIndex()];
    const preview = runCli("patch", root, "--dry-run");
    expect(preview).toContain("Next version: 0.4.1 (patch)");
    expect(preview).toContain(`\n\n${assembled}\n`);
    expect(snapshot()).toEqual(files);
    expect(gitIndex()).toBe(index);

    expect(runCli("patch", root)).toBe("0.4.1\n");
    expect(readdirSync(join(root, "changes"))).toEqual(["README.md"]);
    const staged = execFileSync("git", ["ls-files", "changes"], { cwd: root, encoding: "utf8" });
    expect(staged.trim().split("\n")).toEqual(["changes/README.md"]);
  });

  it("writes nothing when a fragment is malformed", () => {
    makeRepo("0.4.0", "0.4.0", { ...sample, "81-bad.md": ["feature", "- X."] });
    expect(() => bumpRepository(root, "patch")).toThrow(/changes\/81-bad\.md: section/);
    expect(JSON.parse(read("apps/cli/package.json")).version).toBe("0.4.0");
    expect(readdirSync(join(root, "changes"))).toHaveLength(5);
  });

  it("refuses when the CLI and desktop versions disagree", () => {
    makeRepo("0.4.0", "0.3.0");
    expect(() => bumpRepository(root, "patch")).toThrow(/apps\/desktop is 0.3.0/);
  });
});
