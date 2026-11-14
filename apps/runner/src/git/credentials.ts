import type { GitCredential } from "@codeden/contracts";

/**
 * Brokered git credentials (`docs/remote-runners.md` §9.2, option A). The server sends a
 * credential with the one command that needs it (a clone, a fetch, a push); the runner hands it
 * to that git process only and keeps nothing:
 * - `credential.helper=` first empties the helper list, so no configured helper (a credential
 *   store, a keychain, Git Credential Manager, one the repository's own config adds) is asked or
 *   told to store it;
 * - then an inline helper, set only for the credential's `scope` (`credential.<scope>.helper`),
 *   answers `get` from the git process's own environment and ignores `store` and `erase`. Git
 *   asks it only for requests to that scheme and host: an `origin`, `pushurl` or `insteadOf`
 *   an agent rewrote to point elsewhere finds no helper at all.
 *
 * The URL and `.git/config` never hold it.
 */

const USERNAME_VAR = "GIT_BROKER_USERNAME";
const PASSWORD_VAR = "GIT_BROKER_PASSWORD";

/** The inline helper: prints the username and password from the environment on `get` only. */
const HELPER = `!f() { test "$1" = get || exit 0; echo "username=$${USERNAME_VAR}"; echo "password=$${PASSWORD_VAR}"; }; f`;

/** `-c` options that make git use only the brokered credential, and only for its scope. */
export function credentialArgs(credential: GitCredential): string[] {
  return ["-c", "credential.helper=", "-c", `credential.${credential.scope}.helper=${HELPER}`];
}

/** The environment that carries the credential to its git process. */
export function credentialEnv(credential: GitCredential): Record<string, string> {
  return { [USERNAME_VAR]: credential.username, [PASSWORD_VAR]: credential.password };
}

/** `text` with every copy of the credential's password replaced, for error messages. */
export function scrubCredential(text: string, credential: GitCredential | undefined): string {
  if (!credential) return text;
  return text.split(credential.password).join("***");
}
