#!/usr/bin/env node
// Bumps the CodeDen release version everywhere it is written, for the Release workflow's
// "patch / minor / major" choice:
//   apps/cli/package.json, apps/desktop/package.json, packages/contracts/src/version.ts
//   (SOURCE_VERSION), and CHANGELOG.md (the fragments in changes/ become the new version's
//   section; see changes/README.md). The fragments it used are deleted, and their removal is
//   staged in git so the release commit includes it.
//
// Usage: node scripts/release/bump-version.mjs <patch|minor|major> [repo root] [--dry-run]
// Prints the new version (e.g. 0.4.1) on stdout. With --dry-run it prints the version and the
// CHANGELOG section the release would add, and changes nothing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleSection, readFragments, splitUnreleased, UNRELEASED_POINTER } from "./changes.mjs";

export const BUMPS = ["patch", "minor", "major"];

/** The next semantic version: "0.4.0" + "patch" -> "0.4.1", + "minor" -> "0.5.0". */
export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Not a plain x.y.z version: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${bump}" (expected ${BUMPS.join(", ")})`);
}

/** Replaces the `"version"` field of a package.json, keeping its formatting. */
export function setPackageVersion(text, version) {
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error("No version field found in package.json");
  }
  return next;
}

/** Replaces `SOURCE_VERSION` in packages/contracts/src/version.ts. */
export function setSourceVersion(text, version) {
  const pattern = /(export const SOURCE_VERSION = ")[^"]*(";)/;
  if (!pattern.test(text)) throw new Error("SOURCE_VERSION not found in version.ts");
  return text.replace(pattern, `$1${version}$2`);
}

/**
 * Adds `## [version] - date` with `notes` (the assembled fragments) below the changelog's
 * `## [Unreleased]` section, which keeps only its pointer to changes/. Notes written straight
 * under `[Unreleased]` are refused rather than dropped: they belong in a fragment.
 */
export function releaseChangelog(text, version, date, notes) {
  const { before, unreleased, rest } = splitUnreleased(text);
  if (unreleased !== "" && unreleased !== UNRELEASED_POINTER) {
    throw new Error(
      "CHANGELOG.md has notes under ## [Unreleased]; move them into a fragment in changes/ (see changes/README.md)",
    );
  }
  const section = `## [${version}] - ${date}\n\n${notes}\n`;
  return `${before}## [Unreleased]\n\n${UNRELEASED_POINTER}\n\n${section}${rest ? `\n${rest}` : ""}`;
}

/**
 * Applies a bump to the repository at `root`: the three versions, and the changes/ fragments
 * assembled into CHANGELOG.md and deleted. Everything is computed before anything is written.
 * With `dryRun` nothing is written. Returns the new version, the notes and the fragment paths.
 */
export function bumpRepository(root, bump, options = {}) {
  const { date = new Date().toISOString().slice(0, 10), dryRun = false } = options;
  const cliPath = join(root, "apps/cli/package.json");
  const desktopPath = join(root, "apps/desktop/package.json");
  const sourcePath = join(root, "packages/contracts/src/version.ts");
  const changelogPath = join(root, "CHANGELOG.md");
  const changesDir = join(root, "changes");

  const current = JSON.parse(readFileSync(cliPath, "utf8")).version;
  const desktop = JSON.parse(readFileSync(desktopPath, "utf8")).version;
  if (desktop !== current) {
    throw new Error(`apps/desktop is ${desktop} but apps/cli is ${current}; fix that first`);
  }
  const version = nextVersion(current, bump);
  const fragments = readFragments(changesDir);
  const notes = assembleSection(fragments);

  const writes = [
    [cliPath, setPackageVersion(readFileSync(cliPath, "utf8"), version)],
    [desktopPath, setPackageVersion(readFileSync(desktopPath, "utf8"), version)],
    [sourcePath, setSourceVersion(readFileSync(sourcePath, "utf8"), version)],
    [changelogPath, releaseChangelog(readFileSync(changelogPath, "utf8"), version, date, notes)],
  ];
  if (!dryRun) {
    for (const [path, text] of writes) writeFileSync(path, text);
    for (const fragment of fragments) rmSync(join(changesDir, fragment.name));
  }
  return { version, date, notes, fragments: fragments.map((f) => `changes/${f.name}`) };
}

/** Stages the removal of the fragments a release used, so the release commit includes it. */
function stageRemovals(root, paths) {
  if (paths.length === 0 || !existsSync(join(root, ".git"))) return;
  execFileSync("git", ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...paths], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function main(args) {
  const dryRun = args.includes("--dry-run");
  const [bump, root = process.cwd()] = args.filter((arg) => !arg.startsWith("--"));
  const repo = resolve(root);
  const result = bumpRepository(repo, bump, { dryRun });
  if (!dryRun) {
    stageRemovals(repo, result.fragments);
    process.stdout.write(`${result.version}\n`);
    return;
  }
  const used = result.fragments.length > 0 ? result.fragments.join("\n  ") : "(none)";
  process.stdout.write(
    `Dry run: nothing was changed.\nNext version: ${result.version} (${bump})\n` +
      `Fragments it would use and delete:\n  ${used}\n\n` +
      `CHANGELOG.md section:\n\n## [${result.version}] - ${result.date}\n\n${result.notes}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
