import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { freshestBase, prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

/** An upstream repo and a clone of it, with one more commit upstream the clone hasn't seen. */
function clonedBehind() {
  const upstream = makeRepo();
  const clone = tempDir("codeden-clone-");
  const home = tempDir("codeden-home-");
  dirs.push(upstream, clone, home);
  sh(clone, "clone", "-q", upstream, ".");
  sh(clone, "config", "user.name", "Test");
  sh(clone, "config", "user.email", "test@example.com");
  write(upstream, "fresh.txt", "new upstream work\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-q", "-m", "upstream");
  const ctx = { home, supervisor: new ProcessSupervisor(), emit: () => undefined };
  return { upstream, clone, ctx };
}

const prepare = (sessionId: string, repoPath: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  repoPath,
  strategy: "worktree" as const,
  setupCommands: [],
  ...extra,
});

// Git-heavy (clones, fetches, worktrees): slow on loaded Windows runners.
describe("the base of a new worktree", () => {
  it("is the fetched origin/<default> when the local default branch is only behind", async () => {
    const { clone, ctx } = clonedBehind();
    const result = await prepareWorkspace(
      prepare("sess-behind", clone, { baseRef: "main", fetch: true }),
      ctx,
    );
    expect(existsSync(join(result.cwd, "fresh.txt"))).toBe(true);
    // The user's own checkout is untouched.
    expect(existsSync(join(clone, "fresh.txt"))).toBe(false);
    expect(sh(clone, "rev-parse", "main")).not.toBe(sh(clone, "rev-parse", "origin/main"));
  });

  it("keeps the local branch when it has commits of its own", async () => {
    const { clone, ctx } = clonedBehind();
    write(clone, "mine.txt", "local work\n");
    sh(clone, "add", "-A");
    sh(clone, "commit", "-q", "-m", "local");
    const local = sh(clone, "rev-parse", "main");

    const result = await prepareWorkspace(
      prepare("sess-diverged", clone, { baseRef: "main", fetch: true }),
      ctx,
    );
    expect(sh(result.cwd, "rev-parse", "HEAD")).toBe(local);
    expect(existsSync(join(result.cwd, "mine.txt"))).toBe(true);
  });

  it("stays local without a fetch (or when the fetch fails)", async () => {
    const { clone, ctx } = clonedBehind();
    const result = await prepareWorkspace(prepare("sess-offline", clone, { baseRef: "main" }), ctx);
    expect(existsSync(join(result.cwd, "fresh.txt"))).toBe(false);

    sh(clone, "remote", "set-url", "origin", join(clone, "does-not-exist"));
    const failed = await prepareWorkspace(
      prepare("sess-failed", clone, { baseRef: "main", fetch: true }),
      ctx,
    );
    expect(existsSync(join(failed.cwd, "fresh.txt"))).toBe(false);
  });

  it("chooses between local and origin refs", async () => {
    const { clone } = clonedBehind();
    sh(clone, "fetch", "-q", "origin");
    expect(await freshestBase(clone, "main")).toBe("origin/main");
    expect(await freshestBase(clone, "origin/main")).toBe("origin/main");
    expect(await freshestBase(clone, "HEAD")).toBe("HEAD");
    // Not on origin: left alone.
    sh(clone, "branch", "topic");
    expect(await freshestBase(clone, "topic")).toBe("topic");
    // Only on origin: the remote copy.
    sh(clone, "push", "-q", "origin", "topic:only-remote");
    sh(clone, "fetch", "-q", "origin");
    expect(await freshestBase(clone, "only-remote")).toBe("origin/only-remote");
    // Equal to origin counts as behind.
    sh(clone, "merge", "-q", "--ff-only", "origin/main");
    expect(await freshestBase(clone, "main")).toBe("origin/main");
  });
});
