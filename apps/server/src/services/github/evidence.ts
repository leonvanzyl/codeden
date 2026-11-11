import { extname } from "node:path";
import type { GitHubRepo } from "@codeden/contracts";
import type { GithubClient } from "./client";

/** The orphan branch evidence is committed to (§9). */
export const EVIDENCE_BRANCH = "codeden/evidence";

/** One file to publish as evidence. */
export interface EvidenceFile {
  /** File name inside the evidence folder. */
  name: string;
  bytes: Buffer;
  caption?: string;
}

/** A published evidence file. */
export interface PublishedEvidence {
  name: string;
  path: string;
  /** URL that renders inline in comments, also for private repositories. */
  url: string;
  isImage: boolean;
  caption?: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/** Keep names safe for a git path and a URL: `[A-Za-z0-9._-]`, at most 100 characters. */
export function safeFileName(name: string): string {
  const ext = extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "");
  const stem = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 90);
  return `${stem || "file"}${ext}`;
}

/**
 * A blob URL pinned to the commit with `?raw=true`. GitHub serves it to anyone who can read the
 * repository (redirecting to a signed raw URL), so images render inline in issue and PR comments
 * of private repositories too, where `raw.githubusercontent.com` links would not.
 */
export function evidenceUrl(repo: GitHubRepo, commitSha: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${commitSha}/${encoded}?raw=true`;
}

/**
 * Commit files to the `codeden/evidence` orphan branch with the Git Data API (blobs, a tree on
 * top of the branch's current tree, a commit, then the ref), so no local checkout, index or
 * worktree is touched and remote runners work the same. Creates the branch, without parents,
 * on first use. Retries once when another writer moved the branch in between.
 */
export async function commitEvidence(
  client: GithubClient,
  repo: GitHubRepo,
  folder: string,
  files: EvidenceFile[],
  message: string,
): Promise<{ commitSha: string; files: PublishedEvidence[] }> {
  const { owner, repo: name } = repo;
  const used = new Set<string>();
  const entries = files.map((file) => {
    let fileName = safeFileName(file.name);
    for (let i = 2; used.has(fileName); i++) {
      const ext = extname(fileName);
      fileName = `${fileName.slice(0, fileName.length - ext.length)}-${i}${ext}`;
    }
    used.add(fileName);
    return { ...file, path: `${folder}/${fileName}`, fileName };
  });

  return client.run(async (octokit) => {
    const blobs = await Promise.all(
      entries.map(async (e) => {
        const res = await octokit.rest.git.createBlob({
          owner,
          repo: name,
          content: e.bytes.toString("base64"),
          encoding: "base64",
        });
        return { path: e.path, sha: res.data.sha };
      }),
    );
    for (let attempt = 0; ; attempt++) {
      const parent = await currentHead(octokit, owner, name);
      const tree = await octokit.rest.git.createTree({
        owner,
        repo: name,
        ...(parent ? { base_tree: parent.treeSha } : {}),
        tree: blobs.map((b) => ({
          path: b.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: b.sha,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        owner,
        repo: name,
        message,
        tree: tree.data.sha,
        parents: parent ? [parent.commitSha] : [],
      });
      try {
        if (parent) {
          await octokit.rest.git.updateRef({
            owner,
            repo: name,
            ref: `heads/${EVIDENCE_BRANCH}`,
            sha: commit.data.sha,
            force: false,
          });
        } else {
          await octokit.rest.git.createRef({
            owner,
            repo: name,
            ref: `refs/heads/${EVIDENCE_BRANCH}`,
            sha: commit.data.sha,
          });
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (attempt === 0 && (status === 422 || status === 409)) continue;
        throw error;
      }
      const sha = commit.data.sha;
      return {
        commitSha: sha,
        files: entries.map((e) => ({
          name: e.fileName,
          path: e.path,
          url: evidenceUrl(repo, sha, e.path),
          isImage: IMAGE_EXTENSIONS.has(extname(e.fileName).toLowerCase()),
          caption: e.caption,
        })),
      };
    }
  });
}

type Octo = Parameters<Parameters<GithubClient["run"]>[0]>[0];

async function currentHead(
  octokit: Octo,
  owner: string,
  repo: string,
): Promise<{ commitSha: string; treeSha: string } | null> {
  try {
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${EVIDENCE_BRANCH}` });
    const commit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: ref.data.object.sha,
    });
    return { commitSha: commit.data.sha, treeSha: commit.data.tree.sha };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

const TEST_OUTPUT_LIMIT = 50_000;

/** First line of every evidence comment (the factory's merge checks look for it). */
export const EVIDENCE_HEADING = "### Evidence from CodeDen";

/** The Markdown comment for published evidence, a summary and optional test output. */
export function evidenceComment(opts: {
  files: PublishedEvidence[];
  summary?: string;
  testOutput?: string;
  sessionLabel: string;
}): string {
  const parts: string[] = [EVIDENCE_HEADING, ""];
  if (opts.summary) parts.push(opts.summary.trim(), "");
  for (const file of opts.files) {
    if (file.isImage) {
      parts.push(`![${escapeAlt(file.caption ?? file.name)}](${file.url})`);
      if (file.caption) parts.push(`*${file.caption}*`);
    } else {
      parts.push(`- [${file.name}](${file.url})${file.caption ? `: ${file.caption}` : ""}`);
    }
    parts.push("");
  }
  if (opts.testOutput) {
    let output = opts.testOutput.replace(/```/g, "ʼʼʼ");
    if (output.length > TEST_OUTPUT_LIMIT) {
      output = `... (truncated)\n${output.slice(output.length - TEST_OUTPUT_LIMIT)}`;
    }
    parts.push(
      "<details><summary>Test output</summary>",
      "",
      "```text",
      output,
      "```",
      "",
      "</details>",
      "",
    );
  }
  parts.push(`<sub>Posted by ${opts.sessionLabel}</sub>`);
  return parts.join("\n");
}

function escapeAlt(text: string): string {
  return text.replace(/[[\]\n]/g, " ").slice(0, 200);
}
