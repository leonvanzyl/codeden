import type { GitHubRepo, GithubPrDiffFile, GithubPrFile } from "@codeden/contracts";
import type { GithubClient } from "./client";

/** A PR's changed files with their patches, as read from GitHub. */
export type PrFileList = GithubPrDiffFile[];

/** The fields of GitHub's `GET /pulls/:n/files` entries CodeDen reads. */
interface RawPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/**
 * A full unified patch for one file. GitHub's `patch` holds only the hunks; the diff renderer
 * needs the `diff --git`, `---` and `+++` headers to name the file (and pick its language).
 * Null when GitHub sent no patch (binary, too large, or no content change).
 */
export function toUnifiedPatch(
  file: Pick<GithubPrFile, "path" | "previousPath" | "status">,
  patch: string | null | undefined,
): string | null {
  if (!patch) return null;
  const from = file.previousPath ?? file.path;
  const oldName = file.status === "added" ? "/dev/null" : `a/${from}`;
  const newName = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  const hunks = patch.endsWith("\n") ? patch : `${patch}\n`;
  return `diff --git a/${from} b/${file.path}\n--- ${oldName}\n+++ ${newName}\n${hunks}`;
}

function toDiffFile(raw: RawPrFile): GithubPrDiffFile {
  const file: GithubPrFile = {
    path: raw.filename,
    ...(raw.previous_filename ? { previousPath: raw.previous_filename } : {}),
    status: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
  };
  return { ...file, patch: toUnifiedPatch(file, raw.patch) };
}

/** A file without its patch, for `/api/prs/:id`. */
export function withoutPatch({ patch: _patch, ...file }: GithubPrDiffFile): GithubPrFile {
  return file;
}

/** The live fields of `GET /pulls/:n` the PR view shows next to the projection. */
export interface PrInfo {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headSha: string;
  baseBranch: string;
}

export function readPrInfo(client: GithubClient, repo: GitHubRepo, number: number) {
  return client.run(async (octokit): Promise<PrInfo> => {
    const { data } = await octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
    });
    return {
      body: data.body ?? "",
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
      headSha: data.head.sha,
      baseBranch: data.base.ref,
    };
  });
}

/**
 * Changed files of PRs, read page by page (GitHub returns at most 3000) and kept in memory per
 * head commit and base branch: the PR view polls, and a PR's files only change when its head
 * moves or it is retargeted. The few most recent PRs are kept.
 */
export class PrFilesCache {
  private readonly entries = new Map<string, Promise<PrFileList>>();

  constructor(
    private readonly client: GithubClient,
    private readonly max = 8,
  ) {}

  /** The files of PR `number` at `headSha`; read fresh (and not kept) without a head SHA. */
  get(
    repo: GitHubRepo,
    number: number,
    at: { headSha: string | null; baseBranch: string },
  ): Promise<PrFileList> {
    if (!at.headSha) return this.read(repo, number);
    const key = `${repo.owner}/${repo.repo}#${number}@${at.headSha}:${at.baseBranch}`;
    const hit = this.entries.get(key);
    if (hit) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const pending = this.read(repo, number);
    this.entries.set(key, pending);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return pending;
  }

  private read(repo: GitHubRepo, number: number): Promise<PrFileList> {
    return this.client.run(async (octokit) => {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      return files.map((f) => toDiffFile(f));
    });
  }
}
