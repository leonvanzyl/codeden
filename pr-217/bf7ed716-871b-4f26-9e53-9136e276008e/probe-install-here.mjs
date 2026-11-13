// #194 manual check: `pnpm install` in this checkout as an agent shell runs it (stdin an open
// pipe, no TTY, CI unset). Prints whether it prompted, hung or finished.
import { spawn, spawnSync } from "node:child_process";

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 60_000);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(CI|npm_config_ci)$/i.test(key)) delete env[key];

const started = Date.now();
const child = spawn("pnpm", ["install", "--frozen-lockfile"], { env, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const timer = setTimeout(() => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill();
  report("HUNG", null);
}, TIMEOUT_MS);
child.on("exit", (code) => {
  clearTimeout(timer);
  report("exited", code);
});

let done = false;
function report(state, code) {
  if (done) return;
  done = true;
  const prompted = /will be removed and reinstalled from scratch/.test(out);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${state}${code === null ? "" : ` ${code}`} after ${secs}s, prompted: ${prompted}`);
  const lines = out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("Progress:"));
  console.log(lines.slice(-8).join("\n"));
}
