import {
  GEMINI_UPGRADE_COMMAND,
  geminiTooOldMessage,
  isSupportedGeminiVersion,
  readGeminiAuth,
} from "@codeden/providers";
import { base, type CheckEnv, type CheckResult, installFix } from "./check-base";
import { loginFix, lookupTool } from "./tool-lookup";

/**
 * Gemini CLI (§14): a working `gemini` (PATH, then Homebrew's folders on macOS) of at least the
 * version CodeDen supports, then its login read from its own settings (the selected method, the
 * Google account's email, whether the OAuth file exists) and which login variables are set.
 * Credentials are never read. Gemini CLI has no login command: `gemini` on its own asks how to
 * sign in.
 */
export async function checkGemini({
  locate,
  shell,
  platform,
  userHome,
  env,
}: CheckEnv): Promise<CheckResult> {
  const tool = await lookupTool(locate, "gemini", base("gemini"), {
    message: "Gemini CLI is not installed",
    fix: installFix("gemini", platform),
  });
  if (!tool.found) return tool.result;
  const installed = {
    ...base("gemini"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  if (!isSupportedGeminiVersion(tool.version)) {
    // Sessions refuse to open on it: "Gemini CLI 0.36.0 is too old (needs 0.68.0+)".
    return {
      ...installed,
      state: "missing",
      message: geminiTooOldMessage(tool.version),
      fix: { kind: "upgrade", command: GEMINI_UPGRADE_COMMAND },
    };
  }
  const login = loginFix("gemini", shell, tool.path);
  const auth = readGeminiAuth({
    ...(userHome ? { home: userHome } : {}),
    env: env ?? process.env,
  });
  if (auth.loggedIn === null) {
    return {
      ...installed,
      authMethod: auth.authMethod,
      state: "warning",
      message: "Could not confirm the Gemini CLI login",
      ...(auth.note ? { detail: auth.note } : {}),
      fix: login,
    };
  }
  if (!auth.loggedIn) {
    return {
      ...installed,
      loggedIn: false,
      state: "missing",
      message: "Not signed in to Gemini CLI",
      fix: login,
    };
  }
  return {
    ...installed,
    loggedIn: true,
    authMethod: auth.authMethod,
    account: auth.account,
    state: "ok",
    message: "Signed in",
  };
}
