/**
 * CodeDen's own variables: `CODEDEN_HOME`, `CODEDEN_DEPS_INSTALLER`, `CODEDEN_DEBUG` and the
 * rest configure CodeDen's server and runner, never the user's work. Matched in any case:
 * Windows environment names are case-insensitive.
 */
const CODEDEN_VAR = /^CODEDEN_/i;

/**
 * Set when the desktop app runs CodeDen's own processes on its Electron binary (§17). It must
 * not reach the user's agents and shells: an Electron app started there would run as Node.js.
 */
const RUNTIME_ONLY = new Set(["ELECTRON_RUN_AS_NODE"]);

/**
 * Environment for the processes CodeDen starts for the user's work (§15): agents of every
 * provider, terminals and setup scripts. It is `base` (the runner's environment) without
 * CodeDen's own variables, so a CodeDen checkout's tests run in a session never pick up the
 * installer or data folder of the CodeDen running them, then `extra` on top. `extra` holds the
 * variables CodeDen means a process to see (`SessionOptions.env`), so it is kept as given.
 */
export function agentEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || CODEDEN_VAR.test(key) || RUNTIME_ONLY.has(key.toUpperCase())) {
      continue;
    }
    out[key] = value;
  }
  return { ...out, ...extra };
}
