#!/usr/bin/env node
/**
 * Runs `pnpm test` several times while worker threads keep the CPUs busy, the way parallel
 * factory builds do, and reports how many tests failed in each run and how long it took.
 *
 *   node scripts/test-under-load.mjs [--runs 5] [--load <threads>] [-- <vitest args>]
 *
 * `--load` is the number of busy threads (default: one per CPU, a machine that other builds
 * already keep busy); `--load 0` measures the suite on its own.
 * Anything after `--` goes to vitest, e.g. `-- --project @codeden/server`.
 * Exits non-zero when any run failed.
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
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
const load = option("--load", availableParallelism());

const burners = Array.from({ length: load }, () => new Worker("for (;;) {}", { eval: true }));

/** Run `pnpm test` once; resolve with its exit code, duration and vitest's summary lines. */
function runOnce() {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pnpm", ["test", ...vitestArgs], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      process.stdout.write(chunk);
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
      });
    });
  });
}

const results = [];
for (let i = 1; i <= runs; i++) {
  console.log(`\n=== run ${i}/${runs} with ${load} busy threads ===\n`);
  results.push(await runOnce());
}
await Promise.all(burners.map((w) => w.terminate()));

console.log(`\n=== pnpm test under ${load} busy threads ===`);
results.forEach((r, i) => {
  const verdict = r.code === 0 ? "PASS" : "FAIL";
  console.log(`run ${i + 1}: ${verdict} in ${r.seconds}s | files: ${r.files} | tests: ${r.tests}`);
});
const passed = results.filter((r) => r.code === 0).length;
console.log(`${passed}/${runs} runs passed`);
process.exit(passed === runs ? 0 : 1);
