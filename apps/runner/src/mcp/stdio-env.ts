import type { McpStdioEnv } from "@codeden/contracts";

/** Variables Codex passes from its own environment to every local stdio server, on POSIX. */
const CODEX_POSIX_DEFAULTS = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
];

/** The same on Windows. */
const CODEX_WINDOWS_DEFAULTS = [
  "PATH",
  "PATHEXT",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "POWERSHELL",
  "PWSH",
];

/** CA bundle variables Codex also passes on when they are set and not empty. */
const CODEX_CA_VARS = [
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "BUNDLE_SSL_CA_CERT",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
];

/** Added to a failed `allowlist` test of a stdio server that started. */
export const ALLOWLIST_NOTE =
  "Codex starts a stdio server with only a few variables from your environment (PATH, HOME or " +
  "USERPROFILE, the temp folder and the like), the names listed in its env_vars and its env " +
  "table. If the server needs another variable, such as a token, add its name to the " +
  "server's env_vars in ~/.codex/config.toml.";

/**
 * Names in Codex's native `env_vars` list (kept in a spec's `extra`): plain names, or
 * `{ name, source }` tables. A `source = "remote"` entry is read on a remote machine, never
 * from the local environment, so it is left out.
 */
export function codexEnvVarNames(extra: Record<string, unknown> | undefined): string[] {
  const list = extra?.env_vars;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    if (typeof entry === "string") return [entry];
    if (typeof entry !== "object" || entry === null) return [];
    const { name, source } = entry as { name?: unknown; source?: unknown };
    return typeof name === "string" && source !== "remote" ? [name] : [];
  });
}

/**
 * The environment a stdio server starts with in a connection test (`McpStdioEnv`). `base` is
 * the runner's environment (minus CodeDen's own variables); the server's own `env` always wins.
 * Variable names are matched ignoring case on Windows, as the OS does.
 */
export function stdioServerEnv(opts: {
  policy: McpStdioEnv;
  base: Record<string, string>;
  serverEnv: Record<string, string>;
  /** Names to pass from `base` besides the defaults (`allowlist`). */
  envVars: string[];
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const windows = (opts.platform ?? process.platform) === "win32";
  const fold = (name: string) => (windows ? name.toUpperCase() : name);
  const out: Record<string, string> = {};
  const set = (name: string, value: string) => {
    if (windows) {
      for (const key of Object.keys(out)) if (fold(key) === fold(name)) delete out[key];
    }
    out[name] = value;
  };

  if (opts.policy === "inherit") {
    Object.assign(out, opts.base);
  } else {
    const byName = new Map(Object.entries(opts.base).map(([k, v]) => [fold(k), v]));
    const defaults = windows ? CODEX_WINDOWS_DEFAULTS : CODEX_POSIX_DEFAULTS;
    for (const name of [...defaults, ...opts.envVars]) {
      const value = byName.get(fold(name));
      if (value !== undefined) set(name, value);
    }
    for (const name of CODEX_CA_VARS) {
      const value = byName.get(fold(name));
      if (value) set(name, value);
    }
  }
  for (const [name, value] of Object.entries(opts.serverEnv)) set(name, value);
  return out;
}
