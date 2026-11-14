/**
 * The file names of the agent CLIs' own logins (§11.2, §15), by name alone: what `isSecretPath`
 * knows without a home or an environment. `./provider-logins` adds the folders themselves and
 * homes moved by environment variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*`, ...).
 *
 * - Claude Code: `.credentials.json` (its OAuth tokens, in `~/.claude` or `CLAUDE_CONFIG_DIR`
 *   on Linux and Windows) and `.claude.json` (the OAuth account, MCP servers with their keys,
 *   an API key login), plus the backups Claude keeps of it (`.claude.json.backup…`).
 * - Codex: `auth.json` in `.codex` (or `CODEX_HOME`).
 * - Gemini CLI: `oauth_creds.json`, `google_accounts.json` and `mcp-oauth-tokens*.json` in
 *   `.gemini`, and any credential-like name there (its file keychain).
 * - OpenCode: `auth.json`, `mcp-auth.json` and the `opencode.db` database (which holds the
 *   logins from version 2) in its data folder, `opencode`.
 * - Cursor CLI: `auth.json` in a `cursor` config folder, and any credential-like name in
 *   `.cursor` (its file credential store has no documented name).
 * - GitHub CLI: `hosts.yml` in `gh` or `GitHub CLI`.
 */

/** Names that are a login wherever they are. Compared lowercased. */
const ANYWHERE = [
  /^\.credentials\.json$/,
  /^\.claude\.json/,
  /^oauth_creds\.json$/,
  /^google_accounts\.json$/,
  /^mcp-oauth-tokens/,
];

/** Each login folder's file names. Compared lowercased. */
const IN_FOLDER: Record<string, RegExp> = {
  ".codex": /^auth\.json$/,
  opencode: /^(auth\.json|mcp-auth\.json|opencode\.db)/,
  cursor: /^auth\.json$/,
  gh: /^hosts\.ya?ml$/,
  "github cli": /^hosts\.ya?ml$/,
};

/**
 * Names that hold a credential in a provider's own folder: any such name in a dot folder
 * (`.claude`, `.codex`, `.gemini`, `.cursor`), and in the provider folders the session's home
 * and environment point at (`./provider-logins`). Generic folder names (`cursor`, `gh`) elsewhere
 * only count with their known login names, so `src/cursor/token-list.ts` stays ordinary.
 */
export const CREDENTIAL_LIKE = /auth|cred|token|secret|oauth|account|keychain/;

/** Dot folders whose credential-like files are logins, wherever they are. */
const DOT_FOLDERS = new Set([".claude", ".codex", ".gemini", ".cursor"]);

/** The known login file names, for wildcards (`cat ~/.codex/*.json` reaches `auth.json`). */
export const LOGIN_FILE_NAMES = [
  "auth.json",
  ".credentials.json",
  ".claude.json",
  "oauth_creds.json",
  "google_accounts.json",
  "mcp-oauth-tokens.json",
  "mcp-auth.json",
  "opencode.db",
  "hosts.yml",
];

/**
 * True when `base` (a lowercased file name) is a login in one of the provider folders the
 * session's home and environment point at: a known login name, or a credential-like one.
 */
export function isLoginInProviderFolder(base: string): boolean {
  if (ANYWHERE.some((re) => re.test(base))) return true;
  return CREDENTIAL_LIKE.test(base) || /^(hosts\.ya?ml|opencode\.db)/.test(base);
}

/** True when `base` (a file name) is a login in the folder named `folder` (both lowercased). */
export function isLoginInFolder(folder: string, base: string): boolean {
  if (ANYWHERE.some((re) => re.test(base))) return true;
  if (IN_FOLDER[folder]?.test(base)) return true;
  return DOT_FOLDERS.has(folder) && CREDENTIAL_LIKE.test(base);
}

/**
 * True when `normalized` (a path with `/` separators) names an agent CLI's login file by its
 * name and the folder it is in.
 */
export function isLoginFileName(normalized: string): boolean {
  const parts = normalized.toLowerCase().split("/").filter(Boolean);
  const base = parts.at(-1);
  if (!base) return false;
  return isLoginInFolder(parts.at(-2) ?? "", base);
}
