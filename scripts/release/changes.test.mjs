import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleSection,
  parseFragment,
  readFragments,
  strayUnreleasedNotes,
  UNRELEASED_POINTER,
} from "./changes.mjs";

const fragment = (section, body) => `---\nsection: ${section}\n---\n\n${body}\n`;
const note = (name, section, body) => ({ name, section, body });

describe("parseFragment", () => {
  it("reads the section and the bullet lines", () => {
    expect(parseFragment("73-a.md", fragment("fixed", "- **One.** A.\n- **Two.** B."))).toEqual(
      note("73-a.md", "fixed", "- **One.** A.\n- **Two.** B."),
    );
  });

  it("accepts CRLF line endings, a quoted capitalised section and other keys", () => {
    const text = '---\r\nsection: "Security"\r\nissue: 73\r\n---\r\n\r\n- **Safer.** X.\r\n';
    expect(parseFragment("a.md", text)).toEqual(note("a.md", "security", "- **Safer.** X."));
  });

  it.each([
    ["no front matter", "- A note.\n", /must start with front matter/],
    ["an unknown section", fragment("feature", "- A."), /section must be one of added, changed/],
    ["no section", "---\nkind: fixed\n---\n\n- A.\n", /section must be one of .* \(got ""\)/],
    ["an empty note", fragment("added", ""), /has no note/],
    ["a note that isn't a bullet", fragment("added", "A sentence."), /Markdown bullets/],
    ["a heading", fragment("added", "- A.\n\n### Fixed\n\n- B."), /must not contain headings/],
  ])("rejects a fragment with %s, naming the file", (_, text, error) => {
    expect(() => parseFragment("bad.md", text)).toThrow(error);
    expect(() => parseFragment("bad.md", text)).toThrow(/^changes\/bad\.md: .*changes\/README\.md/);
  });

  it.each([
    ["heading indented one space", "- A.\n\n ## Bad heading"],
    ["heading indented two spaces", "- A.\n\n  ## Bad heading"],
    ["heading indented three spaces", "- A.\n\n   ## Bad heading"],
    ["heading indented with a tab", "- A.\n\t# Bad heading"],
    ["heading indented inside a bullet", "- A.\n\n    ### Bad heading"],
    ["bare # line", "- A.\n  #"],
    ["setext === underline", "- A.\nBad heading\n==="],
    ["--- rule or underline", "- A.\n\n---\n\n- B."],
    ["*** rule", "- A.\n\n***"],
  ])("rejects a heading or rule: %s", (_, body) => {
    expect(() => parseFragment("bad.md", fragment("fixed", body))).toThrow(
      /^changes\/bad\.md: must not contain headings or rules \(found "[^"]+"\)/,
    );
  });

  it("allows # inside a line and nested bullets", () => {
    const body = "- **Fixed.** Issue #73 and C# support.\n  - A nested detail.\n  #74 too.";
    expect(parseFragment("ok.md", fragment("fixed", body)).body).toBe(body);
  });
});

describe("assembleSection", () => {
  it("groups fragments by section in a fixed order", () => {
    const notes = [
      note("a.md", "security", "- S."),
      note("b.md", "fixed", "- F."),
      note("c.md", "added", "- A."),
      note("d.md", "removed", "- R."),
      note("e.md", "changed", "- C."),
      note("f.md", "deprecated", "- D."),
    ];
    expect(assembleSection(notes)).toBe(
      "### Added\n\n- A.\n\n### Changed\n\n- C.\n\n### Deprecated\n\n- D.\n\n" +
        "### Removed\n\n- R.\n\n### Fixed\n\n- F.\n\n### Security\n\n- S.",
    );
  });

  it("orders notes within a section by file name, numbers numerically, keeping bullet order", () => {
    const notes = [
      note("100-late.md", "fixed", "- Late."),
      note("unreleased-fixed.md", "fixed", "- Old one.\n- Old two."),
      note("9-early.md", "fixed", "- Early."),
      note("73-middle.md", "fixed", "- Middle."),
    ];
    expect(assembleSection(notes)).toBe(
      "### Fixed\n\n- Early.\n- Middle.\n- Late.\n- Old one.\n- Old two.",
    );
  });

  it("is a maintenance release when there are no fragments", () => {
    expect(assembleSection([])).toBe("Maintenance release.");
  });
});

describe("readFragments", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads every .md file but README.md, sorted by name", () => {
    dir = mkdtempSync(join(tmpdir(), "codeden-changes-"));
    writeFileSync(join(dir, "README.md"), "# Not a fragment\n");
    writeFileSync(join(dir, "12-b.md"), fragment("fixed", "- B."));
    writeFileSync(join(dir, "2-a.md"), fragment("added", "- A."));
    expect(readFragments(dir).map((f) => f.name)).toEqual(["2-a.md", "12-b.md"]);
  });

  it("refuses files that would be skipped silently", () => {
    dir = mkdtempSync(join(tmpdir(), "codeden-changes-"));
    writeFileSync(join(dir, "73-note.txt"), fragment("fixed", "- A."));
    expect(() => readFragments(dir)).toThrow(/changes\/73-note\.txt: only \.md fragments/);
    rmSync(join(dir, "73-note.txt"));
    mkdirSync(join(dir, "nested.md"));
    expect(() => readFragments(dir)).toThrow(/changes\/nested\.md/);
  });

  it("has no fragments when the directory is missing", () => {
    expect(readFragments(join(tmpdir(), "codeden-no-such-changes-dir"))).toEqual([]);
  });
});

describe("strayUnreleasedNotes", () => {
  const changelog = (unreleased) => `# Changelog\n\n## [Unreleased]\n\n${unreleased}## [0.6.0]\n`;

  it("is empty when [Unreleased] holds only the pointer, or nothing", () => {
    expect(strayUnreleasedNotes(changelog(`${UNRELEASED_POINTER}\n\n`))).toBe("");
    expect(strayUnreleasedNotes(changelog(""))).toBe("");
  });

  it("returns notes written under [Unreleased]", () => {
    const text = changelog(`${UNRELEASED_POINTER}\n\n### Fixed\n\n- A bug.\n\n`);
    expect(strayUnreleasedNotes(text)).toBe("### Fixed\n\n- A bug.");
  });
});

// The repository itself: what CI checks on every pull request.
describe("this repository", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

  it("has only well-formed fragments in changes/", () => {
    expect(() => readFragments(join(root, "changes"))).not.toThrow();
  });

  it("keeps CHANGELOG.md's [Unreleased] section to its pointer", () => {
    const stray = strayUnreleasedNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
    expect(
      stray,
      "Notes were added under ## [Unreleased] in CHANGELOG.md. Add a fragment in changes/ instead (see changes/README.md) and leave CHANGELOG.md as it is.",
    ).toBe("");
  });
});
