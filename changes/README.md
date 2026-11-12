# Changelog fragments

Notes for the next release live here, one file per change, instead of in `CHANGELOG.md`. Two pull requests never edit the same file, so they never conflict on the changelog.

## Add a note

A pull request with a user-facing change adds one file named after its issue (or a short slug when there is none): `changes/<issue>-<slug>.md`, for example `changes/73-changelog-fragments.md`.

```md
---
section: fixed
---

- **A bold lead.** What changed, written for people who use CodeDen, in the style of `CHANGELOG.md`.
```

- `section` is one of `added`, `changed`, `deprecated`, `removed`, `fixed` or `security`.
- The note is one or more `- ` bullet lines (nested bullets are fine). No headings or rules (`#` lines at any indentation, `===`, `---`): the release adds the headings. A change that fits two sections gets two files.
- Docs-only and internal changes (refactors, tests, CI) don't need a note.
- Never edit `CHANGELOG.md` for an unreleased change. To reword a note that's already merged, edit its file here.

`pnpm test` checks every file here (front matter with a known section, a bullet note without headings) and that nothing was written under `## [Unreleased]` in `CHANGELOG.md`.

## At release

The Release workflow runs `scripts/release/bump-version.mjs`, which gathers these files into the new version's section of `CHANGELOG.md` and deletes them in the same `chore(release): X.Y.Z` commit. Sections are listed as Added, Changed, Deprecated, Removed, Fixed, Security, and notes within a section by file name (issue numbers in numeric order). With no notes the version reads "Maintenance release."

See what the next release would add, without changing anything:

```sh
pnpm changelog:preview
```
