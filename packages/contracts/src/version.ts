/**
 * The version written into the source; kept in sync with `apps/cli/package.json` and
 * `apps/desktop/package.json` (tested).
 */
export const SOURCE_VERSION = "0.7.2";

/**
 * CodeDen release version. Server and runner exchange it during the runner handshake to detect
 * upgrades. The published entries (`dist/cli.js`, `dist/runner.js`) set
 * `globalThis.__CODEDEN_PACKAGE_VERSION__` from their own `package.json` before loading the
 * rest of the bundle, so the package version is the single source of truth at runtime;
 * everywhere else (workspace, tests) it is `SOURCE_VERSION`.
 */
export const CODEDEN_VERSION: string = packageVersion() ?? SOURCE_VERSION;

function packageVersion(): string | undefined {
  const value = (globalThis as { __CODEDEN_PACKAGE_VERSION__?: unknown })
    .__CODEDEN_PACKAGE_VERSION__;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Version of the server <-> runner WebSocket protocol (§4.3). Bump on breaking changes. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Version of the server <-> UI WebSocket protocol. Bump on breaking changes. */
export const UI_PROTOCOL_VERSION = 1;
