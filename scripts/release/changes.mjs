// Changelog fragments. Each pull request adds its user-facing note as its own file in
// `changes/` instead of editing CHANGELOG.md, so two pull requests never touch the same lines.
// At release, bump-version.mjs assembles the fragments into the new version's section and
// deletes them. The format is described in changes/README.md.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The sections a fragment may name, in the order a release lists them. */
export const SECTIONS = ["added", "changed", "deprecated", "removed", "fixed", "security"];

const TITLES = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};

/** The only text under `## [Unreleased]` in CHANGELOG.md: the notes themselves live in changes/. */
export const UNRELEASED_POINTER =
  "The notes for the next release are in [`changes/`](changes/README.md), one file per change. The release moves them into a version section here.";

const UNRELEASED_HEADING = "## [Unreleased]";
const HEADING_LINE = /^#{1,6}(\s|$)/;

/** File name order with numbers compared as numbers (`9-a.md` before `73-b.md`), locale-fixed. */
const byName = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Parses one fragment: front matter with `section: <added|changed|...>`, then one or more
 * Markdown bullet lines. Throws an error naming the file and the fix when it's malformed.
 */
export function parseFragment(name, text) {
  const fail = (why) => {
    throw new Error(`changes/${name}: ${why} (see changes/README.md)`);
  };
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n?---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) fail("must start with front matter: a `---` line, `section: <name>`, a `---` line");
  const fields = {};
  for (const line of match[1].split("\n")) {
    if (line.trim() === "") continue;
    const field = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!field) fail(`can't read the front matter line "${line}"`);
    fields[field[1].toLowerCase()] = field[2].replace(/^["']|["']$/g, "");
  }
  const section = (fields.section ?? "").toLowerCase();
  if (!SECTIONS.includes(section)) {
    fail(`section must be one of ${SECTIONS.join(", ")} (got "${fields.section ?? ""}")`);
  }
  const body = match[2].trim();
  if (body === "") fail("has no note after the front matter");
  if (!body.startsWith("- ")) fail('the note must be Markdown bullets, each starting with "- "');
  if (body.split("\n").some((line) => HEADING_LINE.test(line))) {
    fail("must not contain headings; the release adds the section headings");
  }
  return { name, section, body };
}

/**
 * Reads every fragment in `dir` (all `*.md` files except README.md), sorted by file name.
 * A missing directory has no fragments; any other file in it is an error, so a note saved
 * with the wrong extension is never skipped silently.
 */
export function readFragments(dir) {
  if (!existsSync(dir)) return [];
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === "readme.md") continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      throw new Error(
        `changes/${entry.name}: only .md fragments and README.md belong in changes/ (see changes/README.md)`,
      );
    }
    names.push(entry.name);
  }
  return names
    .sort(byName)
    .map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")));
}

/**
 * The notes for a release from its fragments: grouped under `### Added`, `### Changed`, ... in
 * SECTIONS order, fragments sorted by file name within a section. No fragments: a maintenance
 * release, so every version still gets a section.
 */
export function assembleSection(fragments) {
  const sorted = [...fragments].sort((a, b) => byName(a.name, b.name));
  const parts = [];
  for (const section of SECTIONS) {
    const bodies = sorted.filter((f) => f.section === section).map((f) => f.body);
    if (bodies.length > 0) parts.push(`### ${TITLES[section]}\n\n${bodies.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "Maintenance release.";
}

/**
 * Splits CHANGELOG.md around its `## [Unreleased]` section: the text before the heading, the
 * section's contents (trimmed) and everything from the next `## [` heading on.
 */
export function splitUnreleased(changelog) {
  const at = changelog.indexOf(UNRELEASED_HEADING);
  if (at === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const after = at + UNRELEASED_HEADING.length;
  const next = changelog.indexOf("\n## [", after);
  return {
    before: changelog.slice(0, at),
    unreleased: changelog.slice(after, next === -1 ? undefined : next).trim(),
    rest: next === -1 ? "" : changelog.slice(next + 1),
  };
}

/** Notes written straight under `## [Unreleased]` instead of in a fragment ("" when none). */
export function strayUnreleasedNotes(changelog) {
  const { unreleased } = splitUnreleased(changelog);
  return unreleased.replace(UNRELEASED_POINTER, "").trim();
}
