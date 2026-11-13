#!/usr/bin/env node
/**
 * Runs `pnpm test` several times on a busy machine and reports how many tests failed in each
 * run and how long it took.
 *
 *   node scripts/test-under-load.mjs [--runs 5] [--parallel <n>] [--load <threads>] [-- <vitest args>]
 *
 * By default each run starts three `pnpm test` at once, 10 s apart, the way a software factory's
 * builders and reviewers do (#179); a run passes when all of them pass. `--parallel` changes how
 * many. `--load` adds that many threads that spin at normal priority (default 0). A spinning
 * thread per CPU is past what the process-heavy suites can take: on Windows, starting a server
 * and runner then takes minutes and Vitest's forks miss their fixed 60 s start-up.
 * Anything after `--` goes to vitest, e.g. `-- --project @codeden/server`.
 * Exits non-zero when any run failed.
 */
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const vitestArgs = split === -1 ? [] : argv.slice(split + 1);
const option = (name, fallback) => {
  const i = own.indexOf(name);
  return i === -1 ? fallback : Number(own[i + 1]);
};
const runs = option("--runs", 5);
const load = option("--load", 0);
const parallel = option("--parallel", 3);

const burners = Array.from({ length: load }, () => new Worker("for (;;) {}", { eval: true }));

/**
 * Run `pnpm test` once; resolve with its exit code, duration, vitest's summary lines and the
 * tests that failed. Output is streamed when it runs alone.
 */
function runOnce(stream) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pnpm", ["test", ...vitestArgs], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      if (stream) process.stdout.write(chunk);
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
      const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
      const line = (label) => plain.match(new RegExp(`^\\s*${label}\\s+(.*)$`, "m"))?.[1] ?? "?";
      resolve({
        code,
        seconds: Math.round((Date.now() - started) / 1000),
        files: line("Test Files"),
        tests: line("Tests"),
        failed: [...new Set(plain.match(/^ *FAIL .*$/gm) ?? [])].map((l) => l.trim()),
      });
    });
  });
}

/** One run: `parallel` copies of `pnpm test`, started 10 s apart. */
async function runRound() {
  const started = [];
  for (let i = 0; i < parallel; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
    started.push(runOnce(parallel === 1));
  }
  return Promise.all(started);
}

const what = `${load} busy threads${parallel > 1 ? `, ${parallel} pnpm test at once` : ""}`;
const results = [];
for (let i = 1; i <= runs; i++) {
  console.log(`\n=== run ${i}/${runs} with ${what} ===\n`);
  const round = await runRound();
  if (parallel > 1) {
    for (const [j, r] of round.entries()) {
      console.log(`pnpm test ${j + 1}: exit ${r.code} in ${r.seconds}s | files: ${r.files}`);
      for (const f of r.failed) console.log(`  ${f}`);
    }
  }
  results.push(round);
}
await Promise.all(burners.map((w) => w.terminate()));

console.log(`\n=== pnpm test under ${what} ===`);
results.forEach((round, i) => {
  const verdict = round.every((r) => r.code === 0) ? "PASS" : "FAIL";
  const each = round.map((r) => `${r.seconds}s, files: ${r.files}, tests: ${r.tests}`);
  console.log(`run ${i + 1}: ${verdict} | ${each.join(" || ")}`);
});
const passed = results.filter((round) => round.every((r) => r.code === 0)).length;
console.log(`${passed}/${runs} runs passed`);
process.exit(passed === runs ? 0 : 1);
