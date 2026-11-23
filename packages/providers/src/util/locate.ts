import { statSync } from "node:fs";
import type { BrokenExecutable } from "@codeden/contracts";
import {
  classify,
  pathCandidates,
  type ResolvedCommand,
  type ResolveOptions,
  runCommand,
} from "./exec";
import { type KnownLocationOptions, knownLocations } from "./known-locations";
import { inspectFile } from "./shim";
import { compareVersions, parseVersion } from "./version";

/** What looking for a tool found (§14). */
export interface ExecutableLookup {
  /**
   * The first copy that runs, or with `minVersion` the first that runs and meets it (an older
   * one only when none does); absent when none runs.
   */
  command?: ResolvedCommand;
  /** From the working copy's `--version`. */
  version: string | null;
  /** Copies found before the working one (or all of them) that do not run. */
  broken: BrokenExecutable[];
}

/** Result of checking that a copy runs. */
export type Validation =
  | { ok: true; version: string | null }
  /** `retry`: a transient failure (a timeout) that is not cached. */
  | { ok: false; reason: string; retry?: boolean };

export interface LocateOptions extends ResolveOptions, KnownLocationOptions {
  /** Folders' files to try after PATH (default: `knownLocations(name)`). */
  knownLocations?: readonly string[];
  /** Check one copy (default: `--version` must exit 0 and print a version). */
  validate?: (command: ResolvedCommand) => Promise<Validation>;
  /** Per-copy `--version` timeout (default 8s). */
  timeoutMs?: number;
  /**
   * The oldest supported version. A copy that runs but is older (or prints no version) is
   * passed over while a later copy meets it, and returned only when none does, so a leftover
   * old install early on PATH does not hide a current one.
   */
  minVersion?: string;
}

/**
 * Every file worth looking at for `name`, in order: PATH (with PATHEXT, then `.ps1` shims on
 * Windows, which are only inspected), then the tool's known install locations.
 */
function candidateFiles(name: string, opts: LocateOptions): string[] {
  const win = (opts.platform ?? process.platform) === "win32";
  const files = [
    ...pathCandidates(name, opts, win ? [".ps1"] : []),
    ...(opts.knownLocations ?? knownLocations(name, opts)),
  ];
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = win ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The first copy of `name` that looks runnable, without running anything: PATH first, then
 * known install locations; broken shims, dangling links and copies whose last `--version`
 * check failed (until they change) are skipped, and so is a copy `findExecutable` passed over
 * as too old, unless nothing else is left. For callers that need an answer synchronously;
 * `findExecutable` also checks that the copy actually runs.
 */
export function quickLocate(name: string, opts: LocateOptions = {}): ResolvedCommand | undefined {
  const win = (opts.platform ?? process.platform) === "win32";
  let outdated: ResolvedCommand | undefined;
  for (const file of candidateFiles(name, opts)) {
    const seen = inspectFile(file, win);
    if (seen.kind !== "candidate") continue;
    const key = cacheKey([file, seen.target]);
    if (key !== undefined && cache.get(key)?.ok === false) continue;
    if (key !== undefined && passedOver.has(key)) {
      outdated ??= classify(file, win);
      continue;
    }
    return classify(file, win);
  }
  return outdated;
}

/**
 * Find a copy of `name` that really runs (§14). Looks on PATH, then in the tool's known
 * install locations; each copy is inspected (a shim's package must exist) and then run with
 * `--version`. Broken copies are skipped and reported, so a working native install wins over
 * a leftover npm shim earlier on PATH. With `minVersion`, a copy that runs but is older is
 * passed over the same way (and remembered, so `quickLocate` agrees) and is the answer only
 * when no copy meets the minimum. Results are cached per file and modification time.
 * Never throws.
 */
export async function findExecutable(
  name: string,
  opts: LocateOptions = {},
): Promise<ExecutableLookup> {
  const win = (opts.platform ?? process.platform) === "win32";
  const broken: BrokenExecutable[] = [];
  /** Copies that run but are older than `minVersion`, in the order found. */
  const outdated: { command: ResolvedCommand; version: string | null; key?: string }[] = [];
  for (const file of candidateFiles(name, opts)) {
    const seen = inspectFile(file, win);
    if (seen.kind === "absent" || seen.kind === "skip") continue;
    if (seen.kind === "broken") {
      broken.push(seen.broken);
      continue;
    }
    const command = classify(file, win);
    const result = await validateCached(command, [file, seen.target], opts);
    if (!result.ok) {
      broken.push({ path: file, reason: result.reason });
      continue;
    }
    const key = cacheKey([file, seen.target]);
    if (opts.minVersion && !meets(result.version, opts.minVersion)) {
      outdated.push({ command, version: result.version, key });
      continue;
    }
    if (key !== undefined) passedOver.delete(key);
    for (const old of outdated) if (old.key !== undefined) passedOver.add(old.key);
    return { command, version: result.version, broken };
  }
  // Nothing meets the minimum: the first old copy is all there is, and callers report it.
  for (const old of outdated) if (old.key !== undefined) passedOver.delete(old.key);
  const [first] = outdated;
  return first
    ? { command: first.command, version: first.version, broken }
    : { version: null, broken };
}

function meets(version: string | null, min: string): boolean {
  return version !== null && compareVersions(version, min) >= 0;
}

const cache = new Map<string, Validation>();
/** Cache keys of copies that run but were passed over for a later, supported copy. */
const passedOver = new Set<string>();
/** The one `ensureLocated` look-up per tool and minimum in this process. */
const located = new Map<string, Promise<void>>();

/**
 * Make sure `findExecutable(name, { minVersion })` has run once in this process, so that
 * `quickLocate` already knows which copies are broken or too old when a runner starts its
 * first session or model list, before any detection. The first call runs the look-up (one
 * `--version` per copy, up to the first supported one); every call returns that same promise.
 * Never rejects.
 */
export function ensureLocated(name: string, minVersion: string): Promise<void> {
  const key = `${name}\n${minVersion}`;
  let run = located.get(key);
  if (!run) {
    run = findExecutable(name, { minVersion }).then(() => undefined);
    located.set(key, run);
  }
  return run;
}

/** Forget cached `--version` results (tests). */
export function clearExecutableCache(): void {
  cache.clear();
  passedOver.clear();
  located.clear();
}

/** The file plus what it launches, by modification time and size: a reinstall changes it. */
function cacheKey(files: (string | undefined)[]): string | undefined {
  const parts: string[] = [];
  for (const file of files) {
    if (!file) continue;
    try {
      const stat = statSync(file);
      parts.push(`${file}|${stat.mtimeMs}|${stat.size}`);
    } catch {
      return undefined;
    }
  }
  return parts.join("\n");
}

async function validateCached(
  command: ResolvedCommand,
  files: (string | undefined)[],
  opts: LocateOptions,
): Promise<Validation> {
  const key = cacheKey(files);
  const hit = key === undefined ? undefined : cache.get(key);
  if (hit) return hit;
  const result = await (opts.validate ?? ((c) => runsVersion(c, opts.timeoutMs)))(command);
  if (key !== undefined && (result.ok || !result.retry)) cache.set(key, result);
  return result;
}

/** `<tool> --version` must exit 0 and print a version. */
export async function runsVersion(
  command: ResolvedCommand,
  timeoutMs = 8_000,
): Promise<Validation> {
  const run = await runCommand(command, ["--version"], { timeoutMs });
  if (run.error) return { ok: false, reason: `could not be started (${run.error.message})` };
  if (run.timedOut) {
    return {
      ok: false,
      reason: `did not answer \`--version\` within ${Math.round(timeoutMs / 1000)}s`,
      retry: true,
    };
  }
  if (run.code !== 0) {
    const why = firstLine(run.stderr) || firstLine(run.stdout);
    return {
      ok: false,
      reason: `exited with code ${run.code} on \`--version\`${why ? ` (${why})` : ""}`,
    };
  }
  const version = parseVersion(run.stdout) ?? parseVersion(run.stderr);
  if (!version) return { ok: false, reason: "printed no version for `--version`" };
  return { ok: true, version };
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
