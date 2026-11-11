import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubIssue, Project, ProjectDetection, RawEventEnvelope } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import { GithubStore } from "../src/services/github/store";
import { ProjectService } from "../src/services/projects/project-service";
import { reconcileProject } from "../src/services/projects/reconcile";

const ts = "2026-11-08T10:00:00.000Z";
const now = "2026-11-08T11:00:00.000Z";

const localProject = {
  id: "p1",
  kind: "local",
  name: "todo",
  slug: "todo",
  path: "/work/todo",
  defaultBranch: null,
  defaultProvider: null,
  autonomy: null,
  autonomyMode: "assisted",
  visionPath: ".codeden/VISION.md",
  factoryLimits: {},
  killSwitch: false,
  timezone: null,
  pinned: false,
  sortOrder: 0,
  createdAt: ts,
  updatedAt: ts,
  archivedAt: null,
} as unknown as Project;

const repo = (owner: string, name: string, url = `https://github.com/${owner}/${name}.git`) => ({
  owner,
  repo: name,
  remoteUrl: url,
  defaultBranch: "main",
});
const githubProject = { ...localProject, kind: "github", github: repo("octo", "todo") } as Project;

function detection(patch: Partial<ProjectDetection> = {}): ProjectDetection {
  return {
    isGitRepo: true,
    gitRoot: "/work/todo",
    remoteUrl: null,
    github: null,
    defaultBranch: "main",
    currentBranch: "main",
    packageManager: null,
    suggestedSetupCommands: [],
    ...patch,
  };
}
const withGithub = (owner: string, name: string, url?: string) => {
  const gh = repo(owner, name, url);
  return detection({ remoteUrl: gh.remoteUrl, github: gh });
};
const facts = { now, gitDirPresent: true, ownCheckout: true };

describe("reconcileProject", () => {
  it("upgrades a local project that gained a GitHub origin", () => {
    const result = reconcileProject(localProject, withGithub("octo", "todo"), facts);
    expect(result).toMatchObject({ changed: true, outcome: "github_connected" });
    expect(result.message).toBe("Connected to octo/todo");
    expect(result.project).toMatchObject({
      kind: "github",
      github: repo("octo", "todo"),
      defaultBranch: "main",
      updatedAt: now,
    });
  });

  it("records the default branch of a folder that became a git checkout", () => {
    const result = reconcileProject(localProject, detection(), facts);
    expect(result).toMatchObject({ changed: true, outcome: "git_detected" });
    expect(result.project.defaultBranch).toBe("main");
    const again = reconcileProject(result.project, detection(), facts);
    expect(again).toMatchObject({ changed: false, outcome: "unchanged" });
    expect(again.message).toBe("Still no GitHub remote on origin");
  });

  it("explains a non-GitHub origin and a folder that is still not a checkout", () => {
    const gitlab = detection({ remoteUrl: "https://gitlab.com/octo/todo.git" });
    expect(
      reconcileProject({ ...localProject, defaultBranch: "main" }, gitlab, facts),
    ).toMatchObject({
      changed: false,
      message:
        "Still no GitHub remote on origin (origin is https://gitlab.com/octo/todo.git, not GitHub)",
    });
    const none = detection({ isGitRepo: false, gitRoot: null, defaultBranch: null });
    const result = reconcileProject(localProject, none, { ...facts, gitDirPresent: false });
    expect(result).toMatchObject({ changed: false, outcome: "unchanged" });
    expect(result.message).toMatch(/^Not a git repository yet/);
  });

  it("follows the remote to another repository, or another URL of the same one", () => {
    const moved = reconcileProject(githubProject, withGithub("acme", "todo-app"), facts);
    expect(moved).toMatchObject({ changed: true, outcome: "github_changed" });
    expect(moved.message).toBe("Now connected to acme/todo-app (was octo/todo)");
    expect(moved.project.kind === "github" && moved.project.github).toEqual(
      repo("acme", "todo-app"),
    );

    const ssh = reconcileProject(
      githubProject,
      withGithub("Octo", "todo", "git@github.com:Octo/todo.git"),
      facts,
    );
    expect(ssh).toMatchObject({ changed: true, outcome: "github_changed" });
    expect(ssh.project.kind === "github" && ssh.project.github.remoteUrl).toBe(
      "git@github.com:Octo/todo.git",
    );
    expect(reconcileProject(githubProject, withGithub("octo", "todo"), facts)).toMatchObject({
      changed: false,
      outcome: "unchanged",
      message: "Connected to octo/todo",
    });
  });

  it("never downgrades a GitHub project that lost its remote; it warns once", () => {
    const missing = reconcileProject(githubProject, detection(), facts);
    expect(missing).toMatchObject({ changed: true, outcome: "github_remote_missing" });
    expect(missing.project).toMatchObject({
      kind: "github",
      github: repo("octo", "todo"),
      remoteWarning: { code: "github_remote_missing", remoteUrl: null, detectedAt: now },
    });
    // The same finding again appends nothing.
    expect(reconcileProject(missing.project, detection(), facts)).toMatchObject({
      changed: false,
      outcome: "github_remote_missing",
    });
    // The remote is back: the warning goes.
    const back = reconcileProject(missing.project, withGithub("octo", "todo"), facts);
    expect(back).toMatchObject({ changed: true, outcome: "github_connected" });
    expect(back.project.remoteWarning).toBeUndefined();
  });

  it("changes nothing when git fails or the folder sits inside another checkout", () => {
    const failed = detection({ isGitRepo: false, gitRoot: null });
    expect(reconcileProject(githubProject, failed, facts)).toMatchObject({ changed: false });
    const parent = reconcileProject(localProject, withGithub("octo", "work"), {
      ...facts,
      ownCheckout: false,
    });
    expect(parent).toMatchObject({ changed: false, outcome: "unchanged" });
    expect(parent.project).toBe(localProject);
  });
});

let dir: string;
let database: Database;
let store: EventStore;
let service: ProjectService;
let events: RawEventEnvelope[];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const projectEvents = () => events.filter((e) => e.type === "project.updated");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-redetect-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  events = [];
  store.subscribe((batch) => events.push(...batch));
  service = new ProjectService({ db: database.db, store, exec: runTool, projectsDir: dir });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function plainFolderProject(): Promise<{ id: string; folder: string }> {
  const folder = join(dir, "test-todo");
  mkdirSync(folder);
  const { project } = await service.create({ source: { type: "local", path: folder } });
  expect(project).toMatchObject({ kind: "local", defaultBranch: null });
  return { id: project.id, folder };
}

describe("ProjectService.refresh", () => {
  it("turns a plain folder that got git init and a GitHub origin into a GitHub project", async () => {
    const { id, folder } = await plainFolderProject();
    expect(await service.refresh(id)).toMatchObject({ changed: false, outcome: "unchanged" });
    expect(projectEvents()).toHaveLength(0);

    git(folder, "init", "-q", "-b", "main");
    git(folder, "remote", "add", "origin", "https://github.com/octo/test-todo.git");
    const result = await service.refresh(id);

    expect(result).toMatchObject({ changed: true, outcome: "github_connected" });
    expect(result.message).toBe("Connected to octo/test-todo");
    expect(result.detected).toMatchObject({ isGitRepo: true, defaultBranch: "main" });
    const stored = service.get(id);
    expect(stored).toMatchObject({
      kind: "github",
      defaultBranch: "main",
      github: {
        owner: "octo",
        repo: "test-todo",
        remoteUrl: "https://github.com/octo/test-todo.git",
        defaultBranch: "main",
      },
    });
    const appended = projectEvents();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toEqual({ project: stored });

    // Nothing new: no event.
    expect(await service.refresh(id)).toMatchObject({ changed: false, outcome: "unchanged" });
    expect(projectEvents()).toHaveLength(1);
  });

  it("records the git root's branch when the folder becomes a checkout without a remote", async () => {
    const { id, folder } = await plainFolderProject();
    git(folder, "init", "-q", "-b", "trunk");
    const result = await service.refresh(id);
    expect(result).toMatchObject({ changed: true, outcome: "git_detected" });
    expect(service.get(id)).toMatchObject({ kind: "local", defaultBranch: "trunk" });
  });

  it("follows a changed remote and forgets the old repository's issues", async () => {
    const { id, folder } = await plainFolderProject();
    git(folder, "init", "-q", "-b", "main");
    git(folder, "remote", "add", "origin", "https://github.com/octo/test-todo.git");
    await service.refresh(id);
    const issue: GithubIssue = {
      projectId: id,
      number: 1,
      title: "Old repo issue",
      state: "open",
      url: "https://github.com/octo/test-todo/issues/1",
      labels: [],
      author: null,
      body: null,
      comments: 0,
      createdAt: null,
      updatedAt: ts,
      closedAt: null,
      sessionIds: [],
    };
    store.append([
      {
        type: "github.synced",
        sessionId: null,
        payload: { projectId: id, issues: [issue], prs: [] },
      },
    ]);
    const github = new GithubStore(database.db);
    github.saveSyncState(id, { ...github.syncState(id), baselineAt: ts, since: ts });
    expect(github.issues(id, "all")).toHaveLength(1);

    git(folder, "remote", "set-url", "origin", "git@github.com:acme/todo-app.git");
    const result = await service.refresh(id);

    expect(result).toMatchObject({ changed: true, outcome: "github_changed" });
    expect(service.get(id)).toMatchObject({
      kind: "github",
      github: { owner: "acme", repo: "todo-app", remoteUrl: "git@github.com:acme/todo-app.git" },
    });
    expect(github.issues(id, "all")).toHaveLength(0);
    expect(github.syncState(id).baselineAt).toBeNull();
  });

  it("warns instead of downgrading when the remote is removed, and lets the user decide", async () => {
    const { id, folder } = await plainFolderProject();
    git(folder, "init", "-q", "-b", "main");
    git(folder, "remote", "add", "origin", "https://github.com/octo/test-todo.git");
    await service.refresh(id);

    git(folder, "remote", "remove", "origin");
    const result = await service.refresh(id);
    expect(result).toMatchObject({ changed: true, outcome: "github_remote_missing" });
    expect(result.message).toBe(
      "This folder has no GitHub remote on origin any more; GitHub features still use octo/test-todo",
    );
    expect(service.get(id)).toMatchObject({
      kind: "github",
      github: { owner: "octo", repo: "test-todo" },
      remoteWarning: { code: "github_remote_missing", remoteUrl: null },
    });
    const count = projectEvents().length;
    expect(await service.refresh(id)).toMatchObject({ changed: false });
    expect(projectEvents()).toHaveLength(count);

    // Restoring the remote clears the warning.
    git(folder, "remote", "add", "origin", "https://github.com/octo/test-todo.git");
    expect(await service.refresh(id)).toMatchObject({ outcome: "github_connected", changed: true });
    expect(service.get(id).remoteWarning).toBeUndefined();

    // Disconnecting is refused while origin still points to GitHub ...
    await expect(service.disconnectGithub(id)).rejects.toMatchObject({
      code: "github_remote_present",
    });
    // ... and in a factory mode.
    git(folder, "remote", "set-url", "origin", "https://gitlab.com/octo/test-todo.git");
    store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...service.get(id), autonomyMode: "software_factory" } },
      },
    ]);
    await expect(service.disconnectGithub(id)).rejects.toMatchObject({ code: "factory_mode" });
    store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...service.get(id), autonomyMode: "assisted" } },
      },
    ]);
    const { project } = await service.disconnectGithub(id);
    expect(project.kind).toBe("local");
    expect(service.get(id)).toMatchObject({ kind: "local", defaultBranch: "main" });
    expect(service.get(id).remoteWarning).toBeUndefined();
  });

  it("reports a missing folder and strips credentials from remote URLs", async () => {
    const { id, folder } = await plainFolderProject();
    git(folder, "init", "-q", "-b", "main");
    git(folder, "remote", "add", "origin", "https://me:secret-token@github.com/octo/test-todo.git");
    const result = await service.refresh(id);
    expect(result.outcome).toBe("github_connected");
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("secret-token");

    rmSync(folder, { recursive: true, force: true });
    expect(await service.refresh(id)).toMatchObject({
      outcome: "folder_missing",
      changed: false,
      detected: null,
    });
  });

  it("applies what the folder looks like today when an archived project is added again", async () => {
    const { id, folder } = await plainFolderProject();
    service.archive(id);
    git(folder, "init", "-q", "-b", "main");
    git(folder, "remote", "add", "origin", "https://github.com/octo/test-todo.git");
    const again = await service.create({ source: { type: "local", path: folder } });
    expect(again.project).toMatchObject({ id, kind: "github", archivedAt: null });
  });
});
