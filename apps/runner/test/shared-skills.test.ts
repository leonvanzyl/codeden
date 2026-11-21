import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSharedSkills } from "../src/workspace/shared-skills";
import { sh } from "./helpers";

let cwd: string;
let outside: string;
const dirs = [".claude/skills", ".agents/skills"];
const skill = (name: string, text = name) => ({
  name,
  content: `---\nname: ${name}\n---\n${text}\n`,
});
const read = (...parts: string[]) => readFileSync(join(cwd, ...parts), "utf8");
const write = (path: string, text: string) => {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), text);
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "codeden-shared-skills-"));
  outside = mkdtempSync(join(tmpdir(), "codeden-shared-outside-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("syncSharedSkills", () => {
  it("writes group skills next to the project's own, and the project's of the same name wins", async () => {
    write(".claude/skills/deploy/SKILL.md", "project's deploy\n");

    const result = await syncSharedSkills(cwd, dirs, [skill("deploy", "group's"), skill("style")]);

    expect(read(".claude/skills/deploy/SKILL.md")).toBe("project's deploy\n");
    expect(read(".claude/skills/style/SKILL.md")).toContain("style");
    expect(read(".agents/skills/deploy/SKILL.md")).toContain("group's");
    expect(result.skipped).toEqual(["deploy"]);
    expect(result.written.sort()).toEqual(["deploy", "style", "style"]);
  });

  it("updates its own copies and removes those the group no longer has, never the project's", async () => {
    write(".claude/skills/mine/SKILL.md", "mine\n");
    await syncSharedSkills(cwd, dirs, [skill("a"), skill("b")]);

    await syncSharedSkills(cwd, dirs, [skill("a", "changed")]);
    expect(read(".claude/skills/a/SKILL.md")).toContain("changed");
    expect(existsSync(join(cwd, ".claude/skills/b"))).toBe(false);

    // The project left its group: an empty list removes every copy and nothing else.
    const result = await syncSharedSkills(cwd, dirs, []);
    expect(result.removed).toEqual(["a", "a"]);
    expect(existsSync(join(cwd, ".agents/skills/a"))).toBe(false);
    expect(read(".claude/skills/mine/SKILL.md")).toBe("mine\n");
  });

  it("keeps the copies out of git, and leaves a skill git brought in over a copy alone", async () => {
    sh(cwd, "init", "-q");
    await syncSharedSkills(cwd, dirs, [skill("deploy")]);
    expect(sh(cwd, "status", "--porcelain", "--untracked-files=all")).toBe("");

    // The project now commits a skill of that name, with the group's very text, and the group
    // drops it: the tracked folder is the project's, so it stays, as does a changed copy.
    write(".claude/skills/deploy/SKILL.md", skill("deploy").content);
    sh(cwd, "add", "-f", ".claude/skills/deploy/SKILL.md");
    write(".agents/skills/deploy/SKILL.md", "edited by hand\n");
    const result = await syncSharedSkills(cwd, dirs, []);
    expect(result.removed).toEqual([]);
    expect(read(".claude/skills/deploy/SKILL.md")).toBe(skill("deploy").content);
    expect(read(".agents/skills/deploy/SKILL.md")).toBe("edited by hand\n");
  });

  it("never writes or removes through a link that leads outside the workspace", async () => {
    symlinkSync(outside, join(cwd, ".claude"));
    const result = await syncSharedSkills(cwd, dirs, [skill("a")]);
    expect(result.blocked).toEqual([".claude/skills"]);
    expect(existsSync(join(outside, "skills"))).toBe(false);
    expect(read(".agents/skills/a/SKILL.md")).toContain("a");
  });

  it("replaces a link planted in its own folder instead of writing through it", async () => {
    await syncSharedSkills(cwd, [".claude/skills"], [skill("a")]);
    const target = join(outside, "target.txt");
    writeFileSync(target, "keep me\n");
    rmSync(join(cwd, ".claude/skills/a/.gitignore"));
    symlinkSync(target, join(cwd, ".claude/skills/a/.gitignore"));

    await syncSharedSkills(cwd, [".claude/skills"], [skill("a", "new")]);
    expect(readFileSync(target, "utf8")).toBe("keep me\n");
  });

  it("ignores names that would leave the skill folder", async () => {
    await syncSharedSkills(cwd, [".claude/skills"], [{ name: "../escape", content: "x" }]);
    expect(existsSync(join(cwd, ".claude/escape"))).toBe(false);
  });
});
