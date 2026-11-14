import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { GitHubRepo, Session } from "@codeden/contracts";
import { type ArtifactService, MAX_ATTACHMENT_BYTES } from "../artifacts";
import { badRequest, forbidden, notFound } from "../errors";
import { realPathOf } from "../files/path-guard";
import { assertNotSecret } from "../secret-files";
import { sessionWorkdir } from "../sessions/workdir";
import { readOutgoingFile } from "../workspace-fs/outgoing";
import type { WorkspaceFs } from "../workspace-fs/workspace-fs";
import type { GithubClient } from "./client";
import { commitEvidence, type EvidenceFile, evidenceComment, evidenceFileNames } from "./evidence";
import { commentOnIssue } from "./issues";

/** One evidence file: a path in the session's worktree, or an artifact (e.g. a screenshot). */
export interface EvidenceSource {
  path?: string;
  artifactId?: string;
  /** File name to publish under (default: the source's name). */
  name?: string;
  caption?: string;
}

export interface AttachEvidenceInput {
  /** Default: the session's PR, else its issue. */
  target?: { kind: "pr" | "issue"; number: number };
  files?: EvidenceSource[];
  /** Markdown shown above the files, e.g. what was verified and how. */
  summary?: string;
  /** Raw test output, posted in a collapsed block (tail kept when long). */
  testOutput?: string;
}

export interface AttachEvidenceResult {
  target: { kind: "pr" | "issue"; number: number };
  commentUrl: string;
  commit: string | null;
  files: Array<{ name: string; url: string }>;
}

export const MAX_EVIDENCE_FILES = 10;

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read evidence sources, confined to the session's worktree, the temp folder and its own
 * artifacts (by id, or by the path `browser_screenshot` prints). Secrets files and CodeDen's
 * own credential files (in `home`, its data directory) are refused wherever they are, since
 * evidence is published to GitHub. A session on another runner (`remote`) attaches files by
 * path from its workspace only, read through that runner (`docs/remote-runners.md` §10).
 */
export async function readEvidence(
  session: Session,
  artifacts: ArtifactService,
  sources: EvidenceSource[],
  home?: string,
  remote?: WorkspaceFs,
): Promise<EvidenceFile[]> {
  if (sources.length > MAX_EVIDENCE_FILES) {
    throw badRequest(`Attach at most ${MAX_EVIDENCE_FILES} files at once`);
  }
  const cwd = sessionWorkdir(session);
  // A remote session's folder is not on this disk: nothing here is looked up for it.
  const roots = remote
    ? []
    : [cwd, tmpdir(), artifacts.sessionDir(session.id)].flatMap((p) => realPathOf(p) ?? []);
  const files: EvidenceFile[] = [];
  for (const source of sources) {
    if (source.path && !source.artifactId && remote) {
      const read = await readOutgoingFile(remote, source.path, { name: source.name, home });
      files.push({ name: read.name, bytes: read.bytes, caption: source.caption });
      continue;
    }
    files.push(readLocalEvidence(session, artifacts, source, roots, cwd, home));
  }

  // The exact names they go out under: `-2` for a repeated name can make one look secret.
  for (const name of evidenceFileNames(files.map((f) => f.name))) {
    assertNotSecret({ names: [name] }, home);
  }
  return files;
}

/** One evidence source from the server's disk (an artifact, or a path in an allowed folder). */
function readLocalEvidence(
  session: Session,
  artifacts: ArtifactService,
  source: EvidenceSource,
  roots: string[],
  cwd: string,
  home: string | undefined,
): EvidenceFile {
  // Every check and the read use the real file (links, junctions and short names resolved).
  let file: string;
  let name: string;
  if (source.artifactId) {
    const artifact = artifacts.get(source.artifactId);
    const sameOwner =
      artifact.sessionId === session.id ||
      (artifact.projectId !== null && artifact.projectId === session.projectId);
    if (!sameOwner) throw forbidden(`Artifact ${source.artifactId} belongs to another project`);
    file = artifacts.realFilePath(artifact);
    name = source.name ?? artifact.name;
    // Its file may be a link to another artifact's file; that one's original name counts too.
    const target = artifacts.artifactForFile(file)?.name;
    assertNotSecret(
      {
        realPath: file,
        paths: [artifacts.filePath(artifact)],
        names: [artifact.name, target, name],
      },
      home,
    );
  } else if (source.path) {
    const absolute = resolve(cwd, source.path);
    const real = existsSync(absolute) && statSync(absolute).isFile() && realPathOf(absolute);
    if (!real) throw notFound(`File not found: ${source.path}`, "file_not_found");
    file = real;
    if (!roots.some((root) => isInside(root, file))) {
      throw forbidden(
        "Only files inside your working directory, the temp folder or your own CodeDen artifacts can be attached (or pass an artifactId)",
      );
    }
    name = source.name ?? basename(file);
    // A stored artifact's file has a generated name; its original name counts too.
    const stored = artifacts.artifactForFile(file)?.name;
    assertNotSecret({ realPath: file, paths: [source.path], names: [stored, name] }, home);
  } else {
    throw badRequest("Each file needs a path or an artifactId");
  }
  if (statSync(file).size > MAX_ATTACHMENT_BYTES) throw badRequest(`${name} is larger than 20 MB`);
  return { name, bytes: readFileSync(file), caption: source.caption };
}

/**
 * `attach_evidence` (§9): commit files to `codeden/evidence` under `<pr-N|issue-N>/<session>/`
 * and post one comment that embeds them (images inline) with the summary and test output.
 */
export async function attachEvidence(
  client: GithubClient,
  artifacts: ArtifactService,
  session: Session,
  repo: GitHubRepo,
  input: AttachEvidenceInput,
  home?: string,
  remote?: WorkspaceFs,
): Promise<AttachEvidenceResult> {
  const target =
    input.target ??
    (session.pr
      ? { kind: "pr" as const, number: session.pr.number }
      : session.issue
        ? { kind: "issue" as const, number: session.issue.number }
        : null);
  if (!target) {
    throw badRequest("This session has no pull request or issue yet; pass target", "no_target");
  }
  const files = await readEvidence(session, artifacts, input.files ?? [], home, remote);
  if (files.length === 0 && !input.summary && !input.testOutput) {
    throw badRequest("Pass files, a summary or test output");
  }
  const folder = `${target.kind}-${target.number}/${session.id}`;
  const published =
    files.length > 0
      ? await commitEvidence(
          client,
          repo,
          folder,
          files,
          `Evidence for ${target.kind === "pr" ? "PR" : "issue"} #${target.number} (session ${session.id})`,
        )
      : null;
  const body = evidenceComment({
    files: published?.files ?? [],
    summary: input.summary,
    testOutput: input.testOutput,
    sessionLabel: session.title
      ? `CodeDen session ${session.title} (\`${session.id}\`)`
      : `CodeDen session \`${session.id}\``,
  });
  const comment = await commentOnIssue({ client }, repo, target.number, body);
  return {
    target,
    commentUrl: comment.url,
    commit: published?.commitSha ?? null,
    files: (published?.files ?? []).map((f) => ({ name: f.name, url: f.url })),
  };
}
