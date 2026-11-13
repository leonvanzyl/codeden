import type { McpServerSpec } from "@codeden/contracts";

/** What a connection test starts or reaches, after environment variables are applied. */
export type ResolvedMcpServer =
  | {
      type: "stdio";
      command: string;
      args: string[];
      /** The server's own variables (on top of the runner's environment). */
      env: Record<string, string>;
      cwd: string | undefined;
    }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

/** A `${VAR}` without a default named a variable that is not set. */
export class MissingEnvError extends Error {
  constructor(readonly names: string[]) {
    super(
      names.length === 1
        ? `Environment variable ${names[0]} is not set`
        : `Environment variables ${names.join(", ")} are not set`,
    );
    this.name = "MissingEnvError";
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` the way Claude Code does in its MCP config: an unset
 * variable takes the default, and one without a default is collected into `missing`.
 */
export function expandEnvVars(
  value: string,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): string {
  return value.replace(PLACEHOLDER, (match, name: string, fallback: string | undefined) => {
    const set = env[name];
    if (set !== undefined) return set;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return match;
  });
}

const mapValues = (o: Record<string, string> | undefined, f: (v: string) => string) =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, f(v)]));

/**
 * Set a header, replacing every copy of it under any casing. HTTP header names are
 * case-insensitive, and two spellings (`authorization` and `Authorization`) would otherwise
 * be sent as one header with both values joined, such as an invalid `Bearer a, Bearer b`.
 */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing];
  }
  headers[name] = value;
}

/**
 * Apply the environment to a spec as the provider would before starting it.
 * - `expandEnv` (Claude): `${VAR}` placeholders in the command, args, env, URL and headers.
 * - Codex: `bearerTokenEnvVar` becomes an `Authorization: Bearer` header, and the native
 *   `env_http_headers` table (header name -> variable name) adds headers from set variables.
 * Header names are matched case-insensitively and one value wins, in this order: the
 * bearer-token variable, then `env_http_headers`, then the headers themselves (the last
 * spelling in the file when the same header appears twice there).
 * Throws `MissingEnvError` naming every variable that is required but not set.
 */
export function resolveMcpSpec(
  spec: McpServerSpec,
  opts: { expandEnv: boolean; env: Record<string, string | undefined> },
): ResolvedMcpServer {
  const missing = new Set<string>();
  const x = (v: string) => (opts.expandEnv ? expandEnvVars(v, opts.env, missing) : v);
  let resolved: ResolvedMcpServer;
  if (spec.type === "stdio") {
    resolved = {
      type: "stdio",
      command: x(spec.command),
      args: (spec.args ?? []).map(x),
      env: mapValues(spec.env, x),
      cwd: spec.cwd ? x(spec.cwd) : undefined,
    };
  } else {
    const url = x(spec.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      setHeader(headers, name, x(value));
    }
    const envHeaders = spec.extra?.env_http_headers;
    if (envHeaders && typeof envHeaders === "object" && !Array.isArray(envHeaders)) {
      for (const [header, variable] of Object.entries(envHeaders)) {
        const value = typeof variable === "string" ? opts.env[variable] : undefined;
        if (value !== undefined) setHeader(headers, header, value);
      }
    }
    if (spec.bearerTokenEnvVar) {
      const token = opts.env[spec.bearerTokenEnvVar];
      if (token === undefined) missing.add(spec.bearerTokenEnvVar);
      else setHeader(headers, "Authorization", `Bearer ${token}`);
    }
    resolved = { type: spec.type, url, headers };
  }
  if (missing.size > 0) throw new MissingEnvError([...missing]);
  return resolved;
}
