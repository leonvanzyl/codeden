import { defaultSettings, type RunnerCommandName, type RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerCommandError } from "../src/runner/client";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import {
  cleanupInboxId,
  RETRY_DELAYS_MS,
  WorktreeCleanup,
} from "../src/services/sessions/worktree-cleanup";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let cleanup: WorktreeCleanup;
/** What the next `workspace.remove` calls do, in order: throw this error, or succeed (null). */
let failures: (Error | null)[];
/** What `workspace.remove` does once `failures` is used up. */
let failWith: Error | null;
/** Every runner command, by name and session. */
let commands: string[];
/** The waits between attempts. */
let waits: number[];

const IN_USE = new RunnerCommandError(
  "worktree_in_use",
  "A file in the worktree is in use (node_modules). Close whatever is using it (a terminal, dev server or editor), then try again.",
);

beforeEach(() => {
  env = createGithubEnv();
  failures = [];
  failWith = IN_USE;
  commands = [];
  waits = [];
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      const sessionId = "sessionId" in command ? ` ${command.sessionId}` : "";
      commands.push(`${command.name}${sessionId}`);
      if (command.name !== "workspace.remove") return {};
      const next = failures.length > 0 ? failures.shift() : failWith;
      if (next) throw next;
      return { removed: true };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  cleanup = new WorktreeCleanup({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    store: env.store,
    settings: () => defaultSettings(),
    stopSession: async () => undefined,
    inbox: env.inbox,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
});

afterEach(() => env.close());

const report = (sessionId: string) => env.inbox.find(cleanupInboxId(sessionId));
const removals = () => commands.filter((c) => c === "workspace.remove").length;

describe("a worktree removal that keeps failing", () => {
  it("is reported in the inbox once, and resolved when a later attempt removes it", async () => {
    const session = env.addSession({ title: "Fix login" });
    const archived = await cleanup.archive(session.id);
    expect(archived.worktree.status).toBe("failed");
    const item = report(session.id);
    expect(item).toMatchObject({
      kind: "cleanup_failed",
      status: "open",
      title: "Couldn't remove the worktree: Fix login",
      sessionId: session.id,
      projectId: env.githubProject.id,
    });
    expect(item?.body).toContain("A file in the worktree is in use");

    // The hourly retry fails the same way: nothing new.
    const before = env.store.listAfter(0, 100_000).length;
    await cleanup.sweep();
    expect(env.store.listAfter(0, 100_000).length).toBe(before);

    failWith = null;
    expect(await cleanup.sweep()).toEqual([session.id]);
    expect(report(session.id)).toMatchObject({ status: "resolved", resolution: { removed: true } });
  });

  it("stays dismissed once the user dismissed it", async () => {
    const session = env.addSession();
    await cleanup.archive(session.id);
    const item = report(session.id);
    if (!item) throw new Error("no report");
    env.inbox.close(item, "dismissed", null);
    failWith = new RunnerCommandError("remove_failed", "Could not delete x: EIO");
    await cleanup.sweep();
    expect(report(session.id)?.status).toBe("dismissed");
  });

  it("is not raised for a worktree kept because of uncommitted changes", async () => {
    const session = env.addSession();
    failWith = new RunnerCommandError("worktree_dirty", "has uncommitted changes");
    expect((await cleanup.archive(session.id)).worktree.status).toBe("kept_changes");
    expect(report(session.id)).toBeUndefined();
    expect(removals()).toBe(1);
  });
});

describe("retrying a removal that failed on a file in use (#99)", () => {
  it("removes the worktree on a later attempt without raising anything", async () => {
    const session = env.addSession();
    failures = [IN_USE, IN_USE];
    failWith = null;
    const archived = await cleanup.archive(session.id);
    expect(archived.worktree).toEqual({ status: "removed", message: null });
    expect(removals()).toBe(3);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(report(session.id)).toBeUndefined();
    expect(env.repo.get(session.id).worktreeRemovedAt).not.toBeNull();
  });

  it("reports only once the backoff is used up", async () => {
    const session = env.addSession();
    expect((await cleanup.archive(session.id)).worktree.status).toBe("failed");
    expect(removals()).toBe(RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(report(session.id)?.status).toBe("open");
  });

  it("doesn't wait on a failure another attempt can't fix", async () => {
    const session = env.addSession();
    failWith = new RunnerCommandError("not_a_worktree", "is not a worktree of this repository");
    expect((await cleanup.archive(session.id)).worktree.status).toBe("failed");
    expect(removals()).toBe(1);
    expect(waits).toEqual([]);
    expect(report(session.id)?.body).toContain("is not a worktree");
  });

  it("stops every session working in the worktree before removing it", async () => {
    const builder = env.addSession({ worktreePath: "/wt/demo/b1", cwd: "/wt/demo/b1" });
    // The reviewer works in the builder's worktree; its status already says it stopped.
    const reviewer = env.addSession({
      worktreePath: null,
      cwd: "/wt/demo/b1",
      status: "stopped",
      archivedAt: "2026-11-12T09:47:20.911Z",
    });
    failWith = null;
    await cleanup.archive(builder.id);
    const removeAt = commands.indexOf("workspace.remove");
    expect(commands.indexOf(`session.stop ${reviewer.id}`)).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf(`session.stop ${reviewer.id}`)).toBeLessThan(removeAt);
    expect(commands.indexOf(`session.stop ${builder.id}`)).toBeLessThan(removeAt);
  });
});
