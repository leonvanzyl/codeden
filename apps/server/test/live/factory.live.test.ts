/**
 * LIVE factory run (§10.1) against a throwaway PRIVATE repository. Opt-in on top of
 * CODEDEN_LIVE because it creates a repository and spends real agent turns:
 *   CODEDEN_LIVE=1 CODEDEN_LIVE_FACTORY=1 pnpm --filter @codeden/server test:live -- factory
 * Creates `codeden-factory-sandbox-<random>` with a tiny Node app, CI (node --test on GitHub
 * Actions) and a VISION.md, switches it to the software factory (auto-merge on), opens one issue, and lets the loop run:
 * Identify type, a real Claude builder (analyze, then implement), a real Codex reviewer, the
 * merge checks, an automatic squash merge, the main-CI watch and the digest.
 * The repository is left in place (the gh token may not delete repos); its name is printed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CreateProjectResponse,
  type FactoryDigest,
  type FactoryItem,
  FactoryStatus,
  GithubIssue,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProcessAlive, type RunningServer, readLiveRunnerLock, startServer } from "../../src";
import { VISION_TEMPLATE } from "../../src/services/factory/vision";
import { waitUntil } from "../support/harness";

const LIVE = process.env.CODEDEN_LIVE === "1" && process.env.CODEDEN_LIVE_FACTORY === "1";
const TOKEN = "e".repeat(64);

const gh = (...args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const APP_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    { name: "factory-sandbox", version: "1.0.0", type: "module", scripts: { test: "node --test" } },
    null,
    2,
  )}\n`,
  "src/math.js": "/** Add two numbers. */\nexport function add(a, b) {\n  return a + b;\n}\n",
  "test/math.test.js":
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  ".github/workflows/ci.yml":
    "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n",
  ".codeden/VISION.md": VISION_TEMPLATE.replace(
    "- What should this project achieve in the next months?",
    "- A tiny, dependable arithmetic library for scripts",
  ).replace(
    "- Who uses it, and what do they need?",
    "- Script authors who need small math helpers",
  ),
  "README.md":
    "# factory sandbox\n\nA tiny arithmetic library used to exercise the CodeDen factory.\n",
};

describe.skipIf(!LIVE)("live factory", () => {
  // Reuse a leftover sandbox (`CODEDEN_LIVE_FACTORY_REPO=codeden-factory-sandbox-xxxxxx`).
  const reuse = process.env.CODEDEN_LIVE_FACTORY_REPO;
  if (reuse && !/^codeden-factory-sandbox-[a-z0-9]+$/.test(reuse)) {
    throw new Error("CODEDEN_LIVE_FACTORY_REPO must name a codeden-factory-sandbox-* repository");
  }
  const name = reuse ?? `codeden-factory-sandbox-${randomBytes(3).toString("hex")}`;
  let owner = "";
  let home = "";
  let server: RunningServer;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  beforeAll(async () => {
    owner = gh("api", "user", "--jq", ".login");
    home = mkdtempSync(join(tmpdir(), "codeden-factory-live-"));
    const repo = join(home, "repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    const credentials = () => {
      git("config", "user.email", "codeden-live@example.com");
      git("config", "user.name", "CodeDen Live");
      // Push with the gh login, for this throwaway clone only.
      git("config", "--local", "--add", "credential.helper", "");
      git("config", "--local", "--add", "credential.helper", "!gh auth git-credential");
    };
    if (reuse) {
      expect(
        gh("repo", "view", `${owner}/${name}`, "--json", "visibility", "--jq", ".visibility"),
      ).toBe("PRIVATE");
      gh("repo", "clone", `${owner}/${name}`, repo);
      credentials();
      console.log(`[live] reusing private repo ${owner}/${name}`);
    } else {
      gh(
        "repo",
        "create",
        `${owner}/${name}`,
        "--private",
        "--description",
        "CodeDen factory live sandbox (safe to delete)",
      );
      console.log(`[live] created private repo ${owner}/${name}`);
      mkdirSync(repo);
      git("init", "-q", "-b", "main");
      credentials();
      for (const [path, contents] of Object.entries(APP_FILES)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), contents);
      }
      git("add", ".");
      git("commit", "-q", "-m", "chore: tiny app, CI and vision");
      git("remote", "add", "origin", `https://github.com/${owner}/${name}.git`);
      git("push", "-q", "-u", "origin", "main");
    }

    server = await startServer({
      port: 0,
      dataDir: join(home, "data"),
      token: TOKEN,
      builtinProviders: true,
      waitForRunner: true,
      secrets: "memory",
      checkSetupOnStart: false,
      userHome: home,
      github: { activeIntervalMs: 10_000, idleIntervalMs: 20_000 },
      factory: { autoTick: false, ciGraceMs: 180_000 },
      log: (m) => {
        if (/factory|error|fail/i.test(m)) console.log(`[server] ${m}`);
      },
    });
    await waitUntil(() => server.runner?.mcpProxyUrl ?? undefined, 60_000);
  }, 240_000);

  afterAll(async () => {
    if (server) {
      const lock = readLiveRunnerLock(server.paths.runnerLock);
      await server.close({ stopRunner: true });
      const deadline = Date.now() + 15_000;
      while (lock && isProcessAlive(lock.pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    console.log(`[live] sandbox repository left in place: ${owner}/${name}`);
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 60_000);

  it(
    "ships one item end to end: Claude builds, Codex reviews, CodeDen merges",
    async () => {
      const project = CreateProjectResponse.parse(
        (await api("POST", "/projects", { source: { type: "local", path: join(home, "repo") } }))
          .body,
      ).project;
      expect(project.kind).toBe("github");
      const projectId = project.id;
      const mode = await api("PUT", `/projects/${projectId}/autonomy`, {
        mode: "software_factory",
        limits: {
          maxConcurrentSessions: 2,
          maxMergesPerDay: 1,
          dailyBudget: { usd: 10 },
          autoMerge: true,
        },
        tuning: { builderProvider: "claude", maxFixAttempts: 1 },
      });
      expect(mode.status).toBe(200);
      expect((await api("POST", `/projects/${projectId}/github/sync`)).status).toBe(200);

      // Incoming work: an issue opened after the factory was enabled.
      const issue = GithubIssue.parse(
        (
          await api("POST", `/projects/${projectId}/github/issues`, {
            title: "Add a clamp function",
            body: "Add `clamp(value, min, max)` to src/math.js next to `add`, with tests.",
          })
        ).body,
      );
      console.log(`[live] issue ${issue.url}`);
      const factory = server.services.factory;
      const tick = async () =>
        FactoryStatus.parse((await api("POST", `/projects/${projectId}/factory/tick`)).body);
      await tick();
      const candidate = await waitUntil(async () => {
        await tick();
        return factory.data.items(projectId).find((i) => i.issue?.number === issue.number);
      }, 60_000);

      // Identify type: the issue is ours (the gh account is always trusted), so it is classified
      // (a feature) and queued for an agent.
      const classified = await waitUntil(async () => {
        await tick();
        const i = factory.data.item(candidate.id);
        return i && i.stage !== "candidate" ? i : undefined;
      }, 120_000);
      console.log(`[live] classified as ${classified.type} (${classified.classification?.by})`);
      expect(classified.trust).toBe("trusted");

      // Drive the loop until the item is done (merged) or stops somewhere else.
      let last = "";
      const final = await waitUntil(async () => {
        await tick();
        const i = factory.data.item(candidate.id) as FactoryItem;
        const line = `${i.stage} ${i.note ?? ""} ${i.checks.map((c) => `${c.name}=${c.state}`).join(" ")}`;
        if (line !== last) console.log(`[live] ${line}`);
        last = line;
        if (i.stage === "rejected") throw new Error(`rejected: ${i.reason}`);
        return ["merged", "failed", "escalated", "reverted"].includes(i.stage) ? i : undefined;
      }, 45 * 60_000);
      console.log(
        `[live] final: ${final.stage} pr=${final.pr?.url} builder=${final.builderProvider} reviewer=${final.reviewerProvider} verdict=${final.review?.verdict} reason=${final.reason}`,
      );
      for (const c of final.checks) console.log(`[live]   ${c.name}: ${c.state} ${c.detail ?? ""}`);
      const digest = (await api("POST", `/projects/${projectId}/factory/digest`))
        .body as FactoryDigest;
      console.log(`[live] digest:\n${digest.text}`);
      expect(final.stage).toBe("merged");
      expect(final.builderProvider).toBe("claude");
      expect(final.reviewerProvider).toBe("codex");
    },
    60 * 60_000,
  );
});
