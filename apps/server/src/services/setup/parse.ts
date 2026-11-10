/**
 * Pure parsers for CLI detection output (§14). They extract only what the setup screen
 * shows; tokens are never captured.
 */

/** First semver-ish version in a `--version` line (`2.1.3 (Claude Code)`, `codex-cli 0.16.0`). */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(output)?.[0] ?? null;
}

export interface ClaudeAuth {
  loggedIn: boolean;
  authMethod: string | null;
  account: string | null;
  loginExpiresAt: string | null;
}

/** `claude auth status` prints JSON with `loggedIn`, `authMethod`, `loginExpiresAt`, `email`. */
export function parseClaudeAuth(stdout: string): ClaudeAuth | null {
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof raw.loggedIn !== "boolean") return null;
    const expires = typeof raw.loginExpiresAt === "string" ? raw.loginExpiresAt : null;
    return {
      loggedIn: raw.loggedIn,
      authMethod: typeof raw.authMethod === "string" ? raw.authMethod : null,
      account: typeof raw.email === "string" ? raw.email : null,
      loginExpiresAt:
        expires && !Number.isNaN(Date.parse(expires)) ? new Date(expires).toISOString() : null,
    };
  } catch {
    return null;
  }
}

/** `codex login status`: exit 0 and "Logged in using ChatGPT" / "Logged in using an API key". */
export function parseCodexLogin(
  code: number | null,
  output: string,
): { loggedIn: boolean; authMethod: string | null } {
  const text = output.trim();
  const m = /logged in using (?:an? )?(.+)/i.exec(text);
  if (code === 0 && m?.[1]) return { loggedIn: true, authMethod: m[1].trim() };
  if (/not logged in/i.test(text)) return { loggedIn: false, authMethod: null };
  return { loggedIn: code === 0, authMethod: null };
}

export interface GhAuth {
  loggedIn: boolean;
  account: string | null;
}

/** `gh auth status --json hosts` (newer gh). Only the active github.com login is read. */
export function parseGhAuthJson(stdout: string): GhAuth | null {
  try {
    const raw = JSON.parse(stdout) as {
      hosts?: Record<string, Array<{ state?: string; active?: boolean; login?: string }>>;
    };
    if (!raw.hosts) return null;
    const accounts = raw.hosts["github.com"] ?? Object.values(raw.hosts).flat();
    const active = accounts.find((a) => a.active) ?? accounts[0];
    if (!active) return { loggedIn: false, account: null };
    return { loggedIn: active.state === "success", account: active.login ?? null };
  } catch {
    return null;
  }
}

/** Fallback for older gh: the human-readable `gh auth status` text. */
export function parseGhAuthText(code: number | null, output: string): GhAuth {
  const m = /Logged in to [^\s]+ (?:account|as) ([^\s(]+)/i.exec(output);
  return { loggedIn: code === 0 && Boolean(m), account: m?.[1] ?? null };
}

/** True when `iso` is within `days` from `now` (or already past). */
export function expiresWithin(iso: string | null, days: number, now = Date.now()): boolean {
  if (!iso) return false;
  return Date.parse(iso) - now < days * 24 * 60 * 60 * 1000;
}

export interface OpenCodeAuth {
  /** Integrations with a connection, by display name (`Anthropic`, `OpenAI`). */
  providers: string[];
  /** How they are connected: `api key`, `oauth`, `environment` (or a mix, comma-separated). */
  authMethod: string | null;
}

/**
 * `opencode auth list --format json`: integrations with their connections, e.g.
 * `[{ "id": "google", "name": "Google", "connections": [{ "type": "env", "name": "GEMINI_API_KEY" }] }]`.
 * An empty list means no provider is connected (OpenCode's own free models still work).
 * Secrets are never part of this output.
 */
export function parseOpenCodeAuth(stdout: string): OpenCodeAuth | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return null;
    const providers: string[] = [];
    const methods = new Set<string>();
    for (const entry of raw as Array<Record<string, unknown>>) {
      const connections = Array.isArray(entry?.connections) ? entry.connections : [];
      if (!connections.length) continue;
      providers.push(String(entry.name ?? entry.id ?? "unknown"));
      for (const c of connections as Array<Record<string, unknown>>) {
        const type = String(c?.type ?? "").toLowerCase();
        methods.add(
          type === "env" ? "environment" : type === "key" ? "api key" : type || "unknown",
        );
      }
    }
    return { providers, authMethod: methods.size ? [...methods].sort().join(", ") : null };
  } catch {
    return null;
  }
}
