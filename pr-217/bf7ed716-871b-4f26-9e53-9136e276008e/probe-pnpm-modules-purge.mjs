// Probe for #194: does `pnpm install` stop on "The modules directory ... will be removed and
// reinstalled from scratch. Proceed?" when run the way an agent shell runs it (stdin an open pipe,
// no TTY), and which setting avoids it? Usage: node scripts/probe-pnpm-modules-purge.mjs
// Offline: the project's only dependency is a local `file:` package. The purge is triggered by
// changing the store location between two installs, one of the layout changes pnpm purges for.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20_000);
const PROMPT = /will be removed and reinstalled from scratch/;

/** The environment without anything that already makes pnpm non-interactive. */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CI|CONTINUOUS_INTEGRATION|BUILD_NUMBER|RUN_ID)$/i.test(key)) delete env[key];
    if (/^(npm|pnpm)_config_(confirm_modules_purge|ci)$/i.test(key)) delete env[key];
  }
  return env;
}

function run(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      // pnpm may run the project's pinned version as a child process: stop the whole tree.
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill();
      resolve({ hung: true, code: null, out });
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ hung: false, code, out });
    });
    // Like an agent shell: stdin stays open and nobody ever answers.
  });
}

const variants = [
  { name: "no setting (today)" },
  { name: ".npmrc confirm-modules-purge=false", npmrc: "confirm-modules-purge=false\n" },
  {
    name: "pnpm-workspace.yaml confirmModulesPurge: false",
    workspace: "confirmModulesPurge: false\n",
  },
  {
    name: "env npm_config_confirm_modules_purge=false",
    env: { npm_config_confirm_modules_purge: "false" },
  },
  {
    name: "env pnpm_config_confirm_modules_purge=false",
    env: { pnpm_config_confirm_modules_purge: "false" },
  },
  { name: "env CI=true", env: { CI: "true" } },
  { name: "env npm_config_ci=true", env: { npm_config_ci: "true" } },
  { name: "env pnpm_config_ci=true", env: { pnpm_config_ci: "true" } },
];

const only = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "codeden-pnpm-purge-"));
const base = cleanEnv();
console.log(`pnpm ${(await run(root, ["--version"], base)).out.trim()}, timeout ${TIMEOUT_MS} ms`);
try {
  for (const [i, v] of variants.entries()) {
    if (only && !v.name.includes(only)) continue;
    const dir = join(root, `p${i}`);
    mkdirSync(join(dir, "dep"), { recursive: true });
    writeFileSync(join(dir, "dep", "package.json"), '{"name":"dep","version":"1.0.0"}\n');
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "probe",
        version: "1.0.0",
        private: true,
        // The version this repository pins; PROBE_PNPM overrides it.
        packageManager: `pnpm@${process.env.PROBE_PNPM ?? "10.12.1"}`,
        dependencies: { dep: "file:./dep" },
      }),
    );
    if (v.npmrc) writeFileSync(join(dir, ".npmrc"), v.npmrc);
    if (v.workspace) writeFileSync(join(dir, "pnpm-workspace.yaml"), v.workspace);
    if (i === 0 || only) {
      const version = (await run(dir, ["--version"], base)).out.trim().split("\n").at(-1);
      console.log(`project pnpm: ${version}`);
    }
    const first = await run(dir, ["install", "--store-dir", join(root, "store-a")], base);
    if (first.hung || first.code !== 0) {
      console.log(`${v.name}: setup install failed\n${first.out}`);
      continue;
    }
    const env = { ...base, ...v.env };
    const second = await run(dir, ["install", "--store-dir", join(root, "store-b")], env);
    const prompted = PROMPT.test(second.out);
    const result = second.hung
      ? `HUNG (killed after ${TIMEOUT_MS} ms)`
      : `exited ${second.code}`;
    console.log(`${v.name}: ${result}, prompted: ${prompted}`);
    if (second.hung || second.code !== 0) {
      console.log(`  output: ${second.out.trim().split("\n").slice(-4).join("\n          ")}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
