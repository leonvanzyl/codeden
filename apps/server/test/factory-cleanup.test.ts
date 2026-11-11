import { join } from "node:path";
import type { FactoryItem, ReviewVerdictInit, Session } from "@codeden/contracts";
import { ReviewVerdict } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SessionArchiver, type SessionArchiverDeps } from "../src/services/factory/cleanup";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Counter increments", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

let env: FactoryEnv;
afterEach(() => env?.close());

/** The software factory with auto-merge on. */
const enable = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
  });
/** One loop step, then the archives it queued. */
const tick = async () => {
  const loop = await env.factory.tick(env.project.id);
  await env.factory.archiver.idle();
  return loop;
};
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const session = (id: string | null) => env.repo.get(id as string);
const setPr = (number: number | undefined, state: "closed" | "merged") => {
  const pr = env.gh.prs.get(number ?? 0);
  if (pr) pr.ref = { ...pr.ref, state };
};

/** A classified feature, already analyzed, waiting for an agent. */
function backlogItem(): FactoryItem {
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:3",
    title: "Add a counter",
    summary: "Users want to count things",
    source: "issue",
    stage: "backlog",
    type: "feature",
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "Missing",
      details: "A counter",
      testPath: null,
      at: new Date().toISOString(),
    },
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 3, url: "https://github.com/acme/app/issues/3", title: "Add a counter" },
  });
}

/** Build an item until its PR is in verification (or past it). */
async function toVerifying(
  it: FactoryItem,
  pr: { files?: string[]; additions?: number } = {},
): Promise<FactoryItem> {
  await tick();
  const builder = item(it.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: it.title,
    files: pr.files ?? ["src/counter.ts", "test/counter.test.ts"],
    additions: pr.additions,
  });
  await env.setStatus(builder, "idle");
  await tick();
  return item(it.id);
}

describe("archiving finished factory work (§10.1)", () => {
  it("archives the reviewer, then the builder, once the merge is done, and only once", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    const verifying = await toVerifying(it1);
    const builder = verifying.builderSessionId as string;
    const reviewer = verifying.reviewerSessionId as string;
    // The reviewer works in the builder's worktree.
    expect(session(reviewer)).toMatchObject({ cwd: session(builder).worktreePath });
    env.gh.commitState.set(`merge${verifying.pr?.number}`, "pending");
    env.factory.submitReview(session(reviewer), ReviewVerdict.parse(APPROVE));
    await tick();
    // Merged, main CI still watched: not finished yet.
    expect(item(it1.id).stage).toBe("watching");
    await env.setStatus(reviewer, "idle");
    await tick();
    expect(env.archived).toEqual([]);

    // Main CI is green while the reviewer is still finishing a turn: it isn't cut off.
    env.gh.commitState.set(`merge${verifying.pr?.number}`, "success");
    await env.setStatus(reviewer, "running");
    await tick();
    const merged = item(it1.id);
    expect(merged).toMatchObject({ stage: "merged", sessionsArchivedAt: null });
    expect(env.archived).toEqual([]);

    await env.setStatus(reviewer, "idle");
    await tick();
    expect(env.archived).toEqual([reviewer, builder]);
    expect(session(builder).archivedAt).not.toBeNull();
    expect(session(builder).worktreeRemovedAt).not.toBeNull();
    const done = item(it1.id);
    expect(done.sessionsArchivedAt).not.toBeNull();
    // Bookkeeping, not progress: the item keeps its place in the digest and the recent list.
    expect(done.updatedAt).toBe(merged.updatedAt);

    // Someone unarchives the builder to look at it again: the factory leaves it be.
    env.repo.update(builder, (s) => ({ ...s, archivedAt: null }));
    await tick();
    expect(env.archived).toEqual([reviewer, builder]);
    expect(session(builder).archivedAt).toBeNull();
  });

  it("keeps escalated work's sessions until a person merges or closes the PR", async () => {
    env = createFactoryEnv();
    enable();
    const escalated = await toVerifying(backlogItem(), {
      files: ["src/auth/login.ts", "test/login.test.ts"],
    });
    expect(escalated.stage).toBe("escalated");
    await tick();
    expect(env.archived).toEqual([]);
    setPr(escalated.pr?.number, "closed");
    await tick();
    expect(item(escalated.id).stage).toBe("rejected");
    expect(env.archived).toEqual([escalated.builderSessionId]);
  });

  it("keeps a size-failed item's builder while the PM may still allow it", async () => {
    env = createFactoryEnv();
    enable();
    const failed = await toVerifying(backlogItem(), { additions: 6_000 });
    expect(failed.stage).toBe("failed");
    expect(failed.reason).toMatch(/size/);
    await tick();
    expect(env.archived).toEqual([]);
    // The PM split the work and closed the oversized PR.
    setPr(failed.pr?.number, "closed");
    await tick();
    expect(env.archived).toEqual([failed.builderSessionId]);
  });

  it("archives earlier reviewers in the builder's worktree, never the scout's area reviewers", async () => {
    env = createFactoryEnv();
    enable();
    const verifying = await toVerifying(backlogItem());
    const builder = verifying.builderSessionId as string;
    const first = verifying.reviewerSessionId as string;
    await env.setStatus(first, "failed");
    await tick(); // The failed reviewer is let go...
    await tick(); // ...and a new one starts.
    const second = item(verifying.id).reviewerSessionId as string;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(session(second).cwd).toBe(session(builder).worktreePath);
    // An area reviewer (a "lens") is long-lived, even in the same folder.
    const lens = await env.factory.ctx.sessions.startLens(env.project.id, "security", "Look");
    const lensId = lens.status === "started" ? lens.sessionId : "";
    env.repo.update(lensId, (s) => ({
      ...s,
      status: "idle",
      cwd: session(builder).worktreePath ?? s.cwd,
    }));
    await env.setStatus(second, "idle");
    setPr(verifying.pr?.number, "closed");
    await tick();
    expect(item(verifying.id).stage).toBe("rejected");
    expect([...env.archived].sort()).toEqual([builder, first, second].sort());
    // Reviewers go first, so the builder's worktree isn't kept for a session still in it.
    expect(env.archived.at(-1)).toBe(builder);
    expect(session(lensId).archivedAt).toBeNull();
  });

  it("archives the earlier attempt's sessions after a retry once their turn is over", async () => {
    env = createFactoryEnv();
    enable();
    const bug = env.gh.openIssue({
      projectId: env.project.id,
      title: "Login fails sometimes",
      author: "codeden",
      labels: ["bug"],
    });
    await tick();
    const it1 = env.factory.data
      .items(env.project.id)
      .find((i) => i.issue?.number === bug.number) as FactoryItem;
    const builder = it1.builderSessionId as string;
    await env.factory.reportReproduction(session(builder), {
      reproduced: false,
      summary: "Logs in every time",
      steps: "Tried 50 logins",
    });
    expect(item(it1.id).stage).toBe("rejected");
    // The builder is still in the turn that reported it: the loop waits.
    await tick();
    expect(env.archived).toEqual([]);

    // Retried at once: the earlier builder is remembered, not archived mid-turn.
    env.factory.retry(env.project.id, it1.id);
    await env.factory.archiver.idle();
    expect(env.archived).toEqual([]);
    expect(item(it1.id)).toMatchObject({
      stage: "backlog",
      builderSessionId: null,
      sessionsArchivedAt: null,
      earlierSessionIds: [builder],
    });
    await tick();
    const next = item(it1.id).builderSessionId;
    expect(next).toBeTruthy();
    expect(next).not.toBe(builder);
    expect(env.archived).toEqual([]);

    // Its turn ends: now it is archived, and only it.
    await env.setStatus(builder, "idle");
    await tick();
    expect(env.archived).toEqual([builder]);
    expect(item(it1.id).earlierSessionIds).toEqual([]);
    expect(session(next).archivedAt).toBeNull();
    await tick();
    expect(env.archived).toEqual([builder]);
  });

  it("leaves a session restored after its cleanup alone when the item is retried", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    await tick();
    const builder = item(it1.id).builderSessionId as string;
    await env.setStatus(builder, "failed");
    await tick();
    expect(item(it1.id).stage).toBe("failed");
    expect(env.archived).toEqual([builder]);
    // You restore the builder to look into it, then retry the item.
    env.repo.update(builder, (s) => ({ ...s, archivedAt: null }));
    env.factory.retry(env.project.id, it1.id);
    expect(item(it1.id).earlierSessionIds).toEqual([]);
    await tick();
    expect(item(it1.id).stage).toBe("building");
    expect(env.archived).toEqual([builder]);
    expect(session(builder).archivedAt).toBeNull();
  });

  it("reaches old work past the newest 500 items and 1,000 sessions", async () => {
    env = createFactoryEnv();
    enable();
    const old = "2026-01-01T00:00:00.000Z";
    const worktree = join(env.dir, "wt", "old-builder");
    const factorySession = (id: string, patch: Partial<Session>): Session => ({
      ...sampleSession,
      id,
      projectId: env.project.id,
      role: "agent",
      startedBy: FACTORY_STARTER,
      status: "idle",
      createdAt: old,
      updatedAt: old,
      ...patch,
    });
    const meta = { workspaceMode: "worktree", workspaceFallback: null, forced: null } as const;
    // An old failed item: its builder, and a reviewer of it restarted long ago (the item no
    // longer points at it), in the builder's worktree with Windows-style slashes.
    env.repo.create(
      factorySession("old-builder", {
        workKey: "issue:7",
        cwd: worktree,
        worktreePath: worktree,
      }),
      { ...meta, queuedBehind: [] },
    );
    env.repo.create(
      factorySession("old-reviewer", {
        workKey: "factory:review:7",
        cwd: `${worktree.replace(/\//g, "\\").toUpperCase()}\\`,
        worktreePath: null,
      }),
      { ...meta, workspaceMode: "existing", queuedBehind: [] },
    );
    const oldItem = env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "issue:7",
      title: "An old item",
      summary: "Failed long ago",
      source: "issue",
      stage: "failed",
      builderSessionId: "old-builder",
    });
    env.factory.data.updateItem(oldItem.id, (i) => ({ ...i, updatedAt: old }), { touch: false });
    // Then 1,000 newer sessions and 500 newer finished items, already cleaned up.
    const now = new Date().toISOString();
    env.store.append(
      Array.from({ length: 1_000 }, (_, n) => ({
        type: "session.created" as const,
        sessionId: `newer-${n}`,
        payload: {
          session: factorySession(`newer-${n}`, {
            workKey: `issue:${100 + n}`,
            cwd: join(env.dir, "wt", `newer-${n}`),
            status: "completed",
            createdAt: now,
            updatedAt: now,
          }),
        },
      })),
    );
    env.store.append(
      Array.from({ length: 500 }, (_, n) => ({
        type: "factory.item.updated" as const,
        sessionId: null,
        payload: {
          item: {
            ...oldItem,
            id: `newer-item-${n}`,
            stage: "merged",
            builderSessionId: null,
            sessionsArchivedAt: now,
          },
        },
      })),
    );
    expect(env.factory.data.items(env.project.id).map((i) => i.id)).not.toContain(oldItem.id);

    await tick();
    expect(env.archived).toEqual(["old-reviewer", "old-builder"]);
    expect(item(oldItem.id).sessionsArchivedAt).not.toBeNull();
  });
});

describe("SessionArchiver", () => {
  it("archives in order, skips gone, archived and busy sessions, and logs failures", async () => {
    const at = new Date().toISOString();
    const sessions = new Map<string, Session>(
      [
        { ...sampleSession, id: "idle", status: "idle" },
        { ...sampleSession, id: "busy", status: "running" },
        { ...sampleSession, id: "archived", status: "completed", archivedAt: at },
        { ...sampleSession, id: "broken", status: "failed" },
      ].map((s) => [s.id, s as Session]),
    );
    const archived: string[] = [];
    const log: string[] = [];
    const repo = {
      find: (id: string) => {
        const s = sessions.get(id);
        return s ? { session: s } : undefined;
      },
    } as unknown as SessionArchiverDeps["repo"];
    const archiver = new SessionArchiver({
      repo,
      archive: async (id) => {
        if (id === "broken") throw new Error("runner gone");
        archived.push(id);
      },
      log: (m) => log.push(m),
    });
    archiver.push(["broken", "gone", "busy", "archived", "idle"]);
    archiver.push(["busy"]);
    await archiver.idle();
    expect(archived).toEqual(["idle"]);
    expect(log).toEqual(["factory: archiving session broken: runner gone"]);
  });
});
