import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedCommand } from "../../util/exec";
import { acquireInstallLock } from "../../util/install-lock";
import { resolveNpm } from "../../util/npm";
import { runNpm } from "../../util/npm-run";
import { installFromRegistry } from "../../util/registry-install";

/** The Claude Agent SDK package. */
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** The SDK version CodeDen is tested with (keep in step with `packages/providers/package.json`). */
export const CLAUDE_SDK_VERSION = "0.3.330";

export type ClaudeSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

/** The SDK version installed in `depsDir`, or null. */
export function installedClaudeSdkVersion(depsDir: string): string | null {
  try {
    const file = join(depsDir, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"), "package.json");
    const version = JSON.parse(readFileSync(file, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** True when `depsDir` holds the tested SDK version. */
export function isClaudeSdkInstalled(depsDir: string): boolean {
  return installedClaudeSdkVersion(depsDir) === CLAUDE_SDK_VERSION;
}

/** Import the SDK installed in `depsDir` (absolute file URL, so it also works on Windows). */
export async function importClaudeSdkFrom(depsDir: string): Promise<ClaudeSdkModule> {
  const entry = createRequire(join(depsDir, "package.json")).resolve(CLAUDE_SDK_PACKAGE);
  const sdk = (await import(pathToFileURL(entry).href)) as ClaudeSdkModule;
  if (typeof sdk.query !== "function") throw new Error(`${entry} does not export query()`);
  return sdk;
}

export interface InstallClaudeSdkOptions {
  depsDir: string;
  /** Progress lines for the UI ("Downloading ...", npm output). */
  onProgress?: (line: string) => void;
  /** Override npm (tests). */
  npm?: ResolvedCommand;
  /**
   * `npm` runs `npm install`; `registry` downloads the tarball straight from the registry and
   * checks its integrity (no npm needed). Default: `CODEDEN_DEPS_INSTALLER` (the desktop app
   * sets `registry`), else npm when one is found, else the registry.
   */
  installer?: "npm" | "registry";
  /** Registry for the `registry` installer (tests); `npm_config_registry` or npmjs.org otherwise. */
  registry?: string;
  fetch?: typeof fetch;
  /** Install timeout (default 5 minutes). */
  timeoutMs?: number;
}

/** Which installer `installClaudeSdk` uses, and the npm to run when it is npm. */
export function chooseInstaller(
  opts: Pick<InstallClaudeSdkOptions, "installer" | "npm">,
  env: NodeJS.ProcessEnv = process.env,
): { kind: "npm"; npm: ResolvedCommand } | { kind: "registry" } {
  const wanted = opts.installer ?? env.CODEDEN_DEPS_INSTALLER;
  if (wanted === "registry") return { kind: "registry" };
  const npm = opts.npm ?? resolveNpm(env);
  if (npm) return { kind: "npm", npm };
  if (wanted === "npm")
    throw new Error("npm was not found; install Node.js with npm and try again");
  return { kind: "registry" };
}

const inflight = new Map<string, Promise<void>>();

/**
 * Install the tested SDK version into `depsDir` with npm, skipping its optional platform
 * binaries and peers (the JS entry needs neither when CodeDen passes the user's `claude`).
 * Concurrent calls share one install per process; a lock file covers other processes.
 * Resolves immediately when it is already installed.
 */
export function installClaudeSdk(opts: InstallClaudeSdkOptions): Promise<void> {
  if (isClaudeSdkInstalled(opts.depsDir)) return Promise.resolve();
  let running = inflight.get(opts.depsDir);
  if (!running) {
    running = runInstall(opts).finally(() => inflight.delete(opts.depsDir));
    inflight.set(opts.depsDir, running);
  }
  return running;
}

async function runInstall(opts: InstallClaudeSdkOptions): Promise<void> {
  const progress = opts.onProgress ?? (() => {});
  mkdirSync(opts.depsDir, { recursive: true });
  const release = await acquireInstallLock(join(opts.depsDir, ".install.lock"), {
    onWait: () => progress("Waiting for another install to finish"),
  });
  try {
    if (isClaudeSdkInstalled(opts.depsDir)) return;
    const manifest = join(opts.depsDir, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(
        manifest,
        `${JSON.stringify({ name: "codeden-deps", private: true }, null, 2)}\n`,
      );
    }
    const installer = chooseInstaller(opts);
    const spec = `${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`;
    if (installer.kind === "registry") {
      // No npm (the desktop app): the SDK's JS entry has no runtime dependencies once its
      // optional platform binaries and peers are left out, so one verified tarball is enough.
      await installFromRegistry({
        name: CLAUDE_SDK_PACKAGE,
        version: CLAUDE_SDK_VERSION,
        nodeModules: join(opts.depsDir, "node_modules"),
        registry: opts.registry,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
        onProgress: progress,
      });
      recordDependency(manifest, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION);
    } else {
      progress(`Downloading ${spec} from npm`);
      await runNpm(
        installer.npm,
        [
          "install",
          spec,
          "--omit=optional",
          "--omit=peer",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          "--prefix",
          opts.depsDir,
        ],
        { cwd: opts.depsDir, timeoutMs: opts.timeoutMs ?? 300_000, onLine: progress },
      );
    }
    const version = installedClaudeSdkVersion(opts.depsDir);
    if (version !== CLAUDE_SDK_VERSION) {
      throw new Error(`npm finished but ${spec} is not in ${opts.depsDir}`);
    }
    progress("Checking the install");
    await importClaudeSdkFrom(opts.depsDir);
    progress(`Installed ${spec}`);
  } finally {
    release();
  }
}

/** Note the installed package in `<deps>/package.json`, as `npm install --save-exact` would. */
function recordDependency(manifest: string, name: string, version: string): void {
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  } catch {
    // rewritten below
  }
  const deps = (typeof pkg.dependencies === "object" && pkg.dependencies) || {};
  pkg.dependencies = { ...(deps as Record<string, string>), [name]: version };
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
}
