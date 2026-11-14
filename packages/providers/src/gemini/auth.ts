import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseJsonc } from "../util/jsonc";

/**
 * What Gemini CLI's own files and the environment say about its login. No credential is ever
 * read: the settings name the login method, the accounts file holds the Google account's email,
 * the OAuth file is only checked for existence, and only the names of variables are looked at.
 */
export interface GeminiAuthInputs {
  /** `security.auth.selectedType` (or the older top-level `selectedAuthType`) of the user's settings. */
  selectedType?: string | null;
  /** The active Google account in `google_accounts.json`. */
  activeAccount?: string | null;
  /** `oauth_creds.json` exists. Gemini CLI may keep the login in the system keychain instead. */
  oauthFile?: boolean;
  /** Read for which variables are set; their values are never read. */
  env?: NodeJS.ProcessEnv;
}

/** Gemini CLI's login as setup reports it: `loggedIn: null` when it can't be confirmed. */
export interface GeminiAuth {
  loggedIn: boolean | null;
  /** Gemini CLI's own auth type: `oauth-personal`, `gemini-api-key`, `vertex-ai`, ... */
  authMethod: string | null;
  account: string | null;
  /** Why the login can't be confirmed, when it can't. */
  note?: string;
}

const has = (env: NodeJS.ProcessEnv, name: string) => !!env[name]?.trim();

/**
 * Gemini CLI's login from its settings and the environment, the way its ACP server picks one
 * for a new session: the auth type selected in its settings, else a gateway URL or
 * `GEMINI_API_KEY` in the environment. Pure.
 */
export function parseGeminiAuth(inputs: GeminiAuthInputs): GeminiAuth {
  const env = inputs.env ?? {};
  const type = inputs.selectedType?.trim() || null;
  const unknown = (authMethod: string, note: string): GeminiAuth => ({
    loggedIn: null,
    authMethod,
    account: null,
    note,
  });
  const yes = (authMethod: string, account: string | null = null): GeminiAuth => ({
    loggedIn: true,
    authMethod,
    account,
  });
  switch (type) {
    case "oauth-personal": {
      const account = inputs.activeAccount?.trim() || null;
      if (account || inputs.oauthFile) return yes(type, account);
      return unknown(
        type,
        "Gemini CLI signs in with Google, but CodeDen can't see that login (it may be in your system keychain)",
      );
    }
    case "gemini-api-key":
      return has(env, "GEMINI_API_KEY")
        ? yes(type)
        : unknown(
            type,
            "Gemini CLI uses an API key, but GEMINI_API_KEY is not in CodeDen's environment (Gemini CLI may read it from a .env file)",
          );
    case "vertex-ai":
      return has(env, "GOOGLE_API_KEY") ||
        (has(env, "GOOGLE_CLOUD_PROJECT") && has(env, "GOOGLE_CLOUD_LOCATION"))
        ? yes(type)
        : unknown(
            type,
            "Gemini CLI uses Vertex AI, but neither GOOGLE_API_KEY nor GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are in CodeDen's environment",
          );
    case "compute-default-credentials":
    case "cloud-shell":
    case "gateway":
      return yes(type);
    case null:
      // No method selected: Gemini CLI's ACP server tries a gateway URL, then an API key.
      if (has(env, "GOOGLE_GEMINI_BASE_URL")) return yes("gateway");
      if (has(env, "GEMINI_API_KEY")) return yes("gemini-api-key");
      return { loggedIn: false, authMethod: null, account: null };
    default:
      return unknown(type, `Gemini CLI uses the login method "${type}", which CodeDen can't check`);
  }
}

/** Gemini CLI's folder: `.gemini` in `GEMINI_CLI_HOME`, else in the user's home. */
export function geminiDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GEMINI_CLI_HOME?.trim() || home, ".gemini");
}

function readJson(file: string): unknown {
  try {
    return parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Read Gemini CLI's login inputs from its folder and the environment, then parse them
 * (`parseGeminiAuth`). Never throws; never reads a credential.
 */
export function readGeminiAuth(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): GeminiAuth {
  const env = opts.env ?? process.env;
  const dir = geminiDir(opts.home ?? homedir(), env);
  const settings = (readJson(path.join(dir, "settings.json")) ?? {}) as {
    security?: { auth?: { selectedType?: unknown } };
    selectedAuthType?: unknown;
  };
  const selected = settings.security?.auth?.selectedType ?? settings.selectedAuthType;
  const accounts = (readJson(path.join(dir, "google_accounts.json")) ?? {}) as {
    active?: unknown;
  };
  return parseGeminiAuth({
    selectedType: typeof selected === "string" ? selected : null,
    activeAccount: typeof accounts.active === "string" ? accounts.active : null,
    oauthFile: existsSync(path.join(dir, "oauth_creds.json")),
    env,
  });
}
