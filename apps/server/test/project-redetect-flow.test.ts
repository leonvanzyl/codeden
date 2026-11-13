import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEventToNewEvent,
  CreateProjectResponse,
  GithubIssuesResponse,
  Project,
  RefreshProjectResponse,
  type Session,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../src";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { type Exec, runTool } from "../src/services/exec";
import { ProjectService } from "../src/services/projects/project-service";
import { ProjectRedetector } from "../src/services/projects/redetector";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";
import { FakeGithub } from "./support/fake-github";
import { startHarness, waitUntil } from "./support/harness";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

const makeGithubRemote = (folder: string, remote = "https://github.com/octo/test-todo.git") => {
  git(folder, "init", "-q", "-b", "main");
  git(folder, "remote", "add", "origin", remote);
};

describe("ProjectRedetector", () => {
  let dir: string;
  let database: Database;
  let store: EventStore;
  let projects: ProjectService;
  let repo: SessionRepo;
  let redetector: ProjectRedetector;
  const githubChanged: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-redetector-"));
    database = openDatabase(join(dir, "codeden.db"));
    store = new EventStore(database.db);
    projects = new ProjectService({ db: database.db, store, exec: runTool, projectsDir: dir });
    repo = new SessionRepo(database.db, store);
    githubChanged.length = 0;
    redetector = new ProjectRedetector({
      projects,
      store,
      repo,
      onGithubChanged: (id) => githubChanged.push(id),
    });
  });

  afterEach(() => {
    redetector.stop();
    database.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function projectWithSession(
    name: string,
  ): Promise<{ id: string; folder: string; session: Session }> {
    const folder = join(dir, name);
    mkdirSync(folder);
    const { project } = await projects.create({ source: { type: "local", path: folder } });
    const session: Session = { ...sampleSession, id: `s-${name}`, projectId: project.id };
    repo.create(session, {
      workspaceMode: "repo_root",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
    });
    return { id: project.id, folder, session };
  }

  const endTurn = (sessionId: string, type: "turn.completed" | "turn.failed" = "turn.completed") =>
    store.append([
      agentEventToNewEvent(
        sessionId,
        type === "turn.completed"
          ? { type, threadId: "t1", turnId: "u1" }
          : { type, threadId: "t1", turnId: "u1", error: { code: "x", message: "boom" } },
      ),
    ]);

  it("checks a local project again when one of its turns ends", async () => {
    redetector.start({ checkAll: false });
    const { id, folder, session } = await projectWithSession("test-todo");
    makeGithubRemote(folder);
    expect(projects.get(id).kind).toBe("local");

    endTurn(session.id);
    const upgraded = await waitUntil(() => {
      const p = projects.get(id);
      return p.kind === "github" ? p : undefined;
    });
    expect(upgraded.github).toMatchObject({ owner: "octo", repo: "test-todo" });
    await waitUntil(() => (githubChanged.includes(id) ? true : undefined));
  });

  it("checks after failed turns too, and leaves GitHub projects alone on turn end", async () => {
    redetector.start({ checkAll: false });
    const { id, folder, session } = await projectWithSession("failing");
    makeGithubRemote(folder);
    endTurn(session.id, "turn.failed");
    await waitUntil(() => (projects.get(id).kind === "github" ? true : undefined));

    const refresh = vi.spyOn(projects, "refresh");
    git(folder, "remote", "remove", "origin");
    endTurn(session.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(refresh).not.toHaveBeenCalled();
    expect(projects.get(id).remoteWarning).toBeUndefined();
  });

  it("checks every project when it starts", async () => {
    const one = await projectWithSession("one");
    const two = await projectWithSession("two");
    makeGithubRemote(two.folder, "git@github.com:octo/two.git");
    redetector.start();
    await waitUntil(() => (projects.get(two.id).kind === "github" ? true : undefined));
    expect(projects.get(one.id).kind).toBe("local");
    expect(githubChanged).toEqual([two.id]);
  });
});

describe("re-detection over HTTP and across restarts", () => {
  const TOKEN = "f".repeat(64);
  let home: string;
  let server: RunningServer | undefined;

  // `gh auth token` is faked; git runs for real. GitHub sync stays off: no network.
  const exec: Exec = (command, args, opts) =>
    command === "gh"
      ? Promise.resolve({
          code: 0,
          stdout: "tok-1\n",
          stderr: "",
          notFound: false,
          timedOut: false,
          path: "gh",
        })
      : runTool(command, args, opts);
  const gh = new FakeGithub();
  const start = () =>
    startServer({
      port: 0,
      dataDir: join(home, "data"),
      token: TOKEN,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      userHome: home,
      exec,
      github: { fetch: gh.fetch, baseUrl: "https://api.github.test", sync: false },
    });
  const api = async (method: string, path: string, body: unknown = {}) => {
    const res = await fetch(`${server?.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const addFolder = async (folder: string) =>
    CreateProjectResponse.parse(
      (await api("POST", "/projects", { source: { type: "local", path: folder } })).body,
    ).project;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codeden-redetect-http-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("refreshes on demand and disconnects GitHub when the user asks", async () => {
    server = await start();
    const folder = join(home, "test-todo");
    mkdirSync(folder);
    const { id } = await addFolder(folder);

    const still = RefreshProjectResponse.parse((await api("POST", `/projects/${id}/refresh`)).body);
    expect(still).toMatchObject({ outcome: "unchanged", changed: false });
    expect(still.message).toMatch(/no GitHub remote/);

    makeGithubRemote(folder);
    const res = await api("POST", `/projects/${id}/refresh`);
    expect(res.status).toBe(200);
    const connected = RefreshProjectResponse.parse(res.body);
    expect(connected).toMatchObject({ outcome: "github_connected", changed: true });
    expect(connected.message).toBe("Connected to octo/test-todo");
    // The GitHub routes now treat it as a GitHub project (local ones have no sync status).
    const issues = GithubIssuesResponse.parse(
      (await api("GET", `/projects/${id}/github/issues`)).body,
    );
    expect(issues.sync).toMatchObject({ projectId: id });
    expect(issues.connection).toMatchObject({ connected: true, login: "octo" });

    expect((await api("POST", `/projects/${id}/disconnect-github`)).status).toBe(409);
    git(folder, "remote", "remove", "origin");
    const warned = RefreshProjectResponse.parse(
      (await api("POST", `/projects/${id}/refresh`)).body,
    );
    expect(warned.project.remoteWarning?.code).toBe("github_remote_missing");
    const disconnected = await api("POST", `/projects/${id}/disconnect-github`);
    expect(disconnected.status).toBe(200);
    expect(Project.parse((await api("GET", `/projects/${id}`)).body).kind).toBe("local");

    expect((await api("POST", "/projects/nope/refresh")).status).toBe(404);
  });

  it("upgrades a project on the next server start", async () => {
    server = await start();
    const folder = join(home, "test-todo");
    mkdirSync(folder);
    const project = await addFolder(folder);
    await server.close();
    makeGithubRemote(folder);

    server = await start();
    const upgraded = await waitUntil(async () => {
      const p = Project.parse((await api("GET", `/projects/${project.id}`)).body);
      return p.kind === "github" ? p : undefined;
    });
    expect(upgraded.github).toMatchObject({ owner: "octo", repo: "test-todo" });
  });
});

describe("re-detection after a real agent turn", () => {
  it("connects the project once a Fake turn ends after the folder got a GitHub origin", async () => {
    // No GitHub sync: the upgraded project must not reach for the real GitHub.
    const h = await startHarness({ github: { sync: false } });
    try {
      git(h.repo, "remote", "add", "origin", "https://github.com/octo/harness.git");
      expect(Project.parse((await h.api("GET", `/projects/${h.projectId}`)).body).kind).toBe(
        "local",
      );
      await h.startFakeSession("set up the GitHub repo");
      const upgraded = await waitUntil(async () => {
        const p = Project.parse((await h.api("GET", `/projects/${h.projectId}`)).body);
        return p.kind === "github" ? p : undefined;
      });
      expect(upgraded.github).toMatchObject({ owner: "octo", repo: "harness" });
    } finally {
      await h.close();
    }
  });
});
