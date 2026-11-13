import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryLimits, Project } from "@codeden/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  isProcessAlive,
  type RunningServer,
  readLiveRunnerLock,
  type StartServerOptions,
  startServer,
} from "../src";
import { currentTurn } from "../src/mcp/transcript";
import { RESTART_CONTINUE_MESSAGE } from "../src/services/sessions/recovery";
import { FakeFactoryGithub } from "./support/fake-factory-github";
import { removeTree } from "./support/remove-tree";

const TOKEN = "e".repeat(64);
let home: string;
let server: RunningServer;
/** Scripted GitHub: no test here reaches the network. */
const github = new FakeFactoryGithub();
const options = (): StartServerOptions => ({
  port: 0,
  dataDir: home,
  token: TOKEN,
  enableFakeProvider: true,
  waitForRunner: true,
  secrets: "memory",
  checkSetupOnStart: false,
  userHome: home,
  github: { sync: false },
  factory: { autoTick: false, github },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-recover-"));
  server = await startServer(options());
});

afterAll(async () => {
  const lock = readLiveRunnerLock(server.paths.runnerLock);
  await server.close({ stopRunner: true });
  const deadline = Date.now() + 10_000;
  while (lock && isProcessAlive(lock.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await removeTree(home);
});

async function until<T>(check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

it("resumes a turn cut off by a runner drain and tells the agent to continue", async () => {
  const s = server.services;
  // A long prompt keeps the Fake turn streaming for a few seconds (one delta per word).
  const prompt = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
  const started = await s.sessions.start({
    projectId: null,
    role: "orchestrator",
    provider: "fake",
    startedBy: { kind: "user" },
    workspace: { mode: "worktree" },
    input: { text: prompt, attachments: [] },
  });
  if (started.status !== "started") throw new Error(started.status);
  const id = started.sessionId;
  await until(() => s.sessionRepo.get(id).status === "running");
  const oldPid = readLiveRunnerLock(server.paths.runnerLock)?.pid;

  await server.runner?.request({
    name: "runner.drain",
    reason: "test restart",
    exitWhenDrained: true,
    timeoutMs: 100,
  });

  // A fresh runner takes over and the session is resumed with the continue message.
  await until(() => {
    const pid = readLiveRunnerLock(server.paths.runnerLock)?.pid;
    return pid !== undefined && pid !== oldPid && server.runner?.status.state === "connected";
  });
  const reply = await until(() => {
    const thread = s.sessionRepo.get(id).rootThreadId;
    if (!thread) return undefined;
    const page = s.sessionRepo.threadPage(id, thread, { limit: 200 });
    return page.items.find(
      (r) => r.item.kind === "assistant_message" && r.item.text.includes(RESTART_CONTINUE_MESSAGE),
    );
  }, 45_000);
  expect(reply).toBeTruthy();
  await until(() => s.sessionRepo.get(id).status === "idle");
  const types = s.store.listAfter(0, 100_000).map((e) => e.type);
  expect(types).toContain("runner.draining");
  expect(types).toContain("agent.turn.interrupted");
}, 90_000);

it("keeps a PM turn the user started through a server-only restart (#137)", async () => {
  const GH = "p-gh-restart";
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const at = new Date().toISOString();
  const project = Project.parse({
    id: GH,
    kind: "github",
    name: "Widgets",
    slug: "widgets-restart",
    path: repo,
    defaultBranch: "main",
    defaultProvider: "fake",
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    pinned: false,
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    github: {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      defaultBranch: "main",
    },
  });
  // An issue by "stranger", who isn't a trusted author and has no write access.
  server.services.store.append([
    { type: "project.created", sessionId: null, payload: { project } },
    {
      type: "issue.updated",
      sessionId: null,
      payload: {
        issue: {
          projectId: GH,
          number: 46,
          title: "Add a webhook",
          state: "open",
          url: "https://github.com/acme/widgets/issues/46",
          labels: [],
          author: "stranger",
          body: null,
          comments: 0,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          sessionIds: [],
        },
        changes: ["imported"],
      },
    },
  ]);

  // The user asks the PM in their own message; its turn waits on an approval.
  const sent = await fetch(`${server.url}/api/orchestration/projects/${GH}/pm/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ input: { text: "[approval] Start a session on issue #46 for me." } }),
  });
  const pmId = ((await sent.json()) as { sessionId: string }).sessionId;
  await until(() => server.services.sessionRepo.get(pmId).status === "waiting");
  const turnBefore = currentTurn(server.services, pmId).turnId;
  expect(server.services.orchestration.loops.humanLed({ caller: "mcp", sessionId: pmId })).toBe(
    true,
  );

  // Only the server restarts: the runner keeps the PM's turn going.
  await server.close();
  server = await startServer(options());
  await until(() => server.runner?.status.state === "connected");
  const after = server.services.sessionRepo.get(pmId);
  expect(after.status).toBe("waiting");
  expect(currentTurn(server.services, pmId).turnId).toBe(turnBefore);

  // Still the user's turn: the PM may start work on the stranger's issue for them.
  const res = await server.services.tools.call(
    "start_session",
    { prompt: "Fix issue #46.", purpose: "Resolve #46", issueNumber: 46 },
    {
      role: "pm",
      sessionId: pmId,
      projectId: GH,
      caller: "mcp",
      signal: new AbortController().signal,
    },
  );
  expect(res.text).not.toContain("wasn't started by the user's own message");
  expect(res.isError).toBe(false);
}, 90_000);
