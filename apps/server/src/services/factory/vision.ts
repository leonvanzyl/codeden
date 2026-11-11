import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Project, parseVision, type VisionResponse } from "@codeden/contracts";
import { badRequest } from "../errors";

export { parseProtectedAreas, parseVision } from "@codeden/contracts";

/**
 * The project vision (§10.1): `.codeden/VISION.md`, required for the software and dark factory.
 * Sections are `##` headings; bullets under them are the entries. Protected areas become path
 * globs (anything in backticks, or that looks like a path) and topics (plain words).
 */

export const VISION_TEMPLATE = `# Vision

Describe what this project is for. The factory scores every piece of work against this file.

## Goals
- What should this project achieve in the next months?

## Target users
- Who uses it, and what do they need?

## Principles
- Small, well-tested changes
- Keep the public API stable

## Out of scope
- Things the factory must never propose

## Quality bar
- Every behaviour change comes with tests
- CI is green before merge

## Protected areas
Paths (globs in backticks) and topics that always need a human. The factory never merges
changes that touch them; they go to your inbox.
- \`**/auth/**\`
- \`**/migrations/**\`
- \`.github/workflows/**\`
- \`LICENSE\`
- payments
- licensing
`;

/** Paths that deploy or release, protected unless `allowDeploys` is on. */
export const DEPLOY_GLOBS = [
  ".github/workflows/*deploy*",
  ".github/workflows/*release*",
  ".github/workflows/*publish*",
  "**/Dockerfile",
  "**/fly.toml",
  "**/vercel.json",
  "**/netlify.toml",
];

/** True when `topic` appears as a word or phrase in `text`. */
export function mentionsTopic(text: string, topic: string): boolean {
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function visionFile(project: Project): string {
  const file = resolve(project.path, project.visionPath);
  const rel = relative(project.path, file);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw badRequest("The vision path must stay inside the project", "invalid_vision_path");
  }
  return file;
}

/** Read the vision; the template (and `exists: false`) when the file is missing. */
export function readVision(project: Project): VisionResponse {
  const file = visionFile(project);
  const exists = existsSync(file);
  const contents = exists ? readFileSync(file, "utf8") : VISION_TEMPLATE;
  return { path: project.visionPath, exists, contents, parsed: parseVision(contents) };
}

/** Write the vision atomically (in the main checkout; commit it to share it with agents). */
export function writeVision(project: Project, contents: string): VisionResponse {
  const file = visionFile(project);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents.endsWith("\n") ? contents : `${contents}\n`);
  renameSync(tmp, file);
  return readVision(project);
}
