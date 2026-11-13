import { basename, dirname, join, resolve } from "node:path";
import { CODEDEN_CREDENTIAL_FILES, INVALID_COPY_SUFFIX } from "@codeden/contracts";
import { isSecretPath } from "@codeden/providers";
import { forbidden } from "./errors";
import { realPathOf } from "./files/path-guard";
import { safeFileName } from "./github/evidence";

/** A file on its way out of the machine, by every name it goes by. */
export interface OutgoingFile {
  /** Its real path (`realPathOf`: links and short names resolved), when it comes from disk. */
  realPath?: string;
  /** Paths it was asked for by, or is stored at: checked whole and by their file name. */
  paths?: ReadonlyArray<string | undefined>;
  /**
   * Names it is published or saved under, now or later (an artifact's name is published when
   * it is attached by id): checked as given and as evidence publishes them.
   */
  names: ReadonlyArray<string | undefined>;
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
const comparable = (p: string) => fold(resolve(p));
/** Both sides resolve the same way: symlinks, junctions and short names (`LEON~1`). */
const canonical = (p: string) => comparable(realPathOf(p) ?? p);

/**
 * True when `file` is one of CodeDen's own credential files in `home` (§15), or a copy CodeDen
 * kept of one it found damaged (`<file>.invalid-<timestamp>` next to it, with the same secrets).
 */
export function isCodedenCredentialFile(file: string, home: string): boolean {
  const target = canonical(file);
  return CODEDEN_CREDENTIAL_FILES.some((name) => {
    const credential = join(home, name);
    if (canonical(credential) === target) return true;
    const copyPrefix = fold(`${basename(credential)}${INVALID_COPY_SUFFIX}`);
    return (
      dirname(target) === canonical(dirname(credential)) && basename(target).startsWith(copyPrefix)
    );
  });
}

/**
 * Refuse secrets on their way out (§9 Evidence, §15). `attach_evidence` publishes files to
 * GitHub, and `share_to_chat` stores artifacts `attach_evidence` can publish by id. Calls to
 * CodeDen's own tools skip the risk classifier, so these tools check here: a file `isSecretPath`
 * matches by any of its names (`.env`, SSH keys, `.npmrc`, `*.pem`, ...), or one of CodeDen's
 * own credential files in `home`, is refused with `403 secret_file` at every permission level.
 * Names are also checked as evidence publishes them (`safeFileName`, which turns anything but
 * `[A-Za-z0-9._-]`, separators included, into `-`), so `-id_rsa`, `notes.p!em` and
 * `service/account.json` can't go out as `id_rsa`, `notes.pem` and `service-account.json`;
 * paths by their file name only, which is what they are published under. The `-2` evidence
 * adds to repeated names can still make one look like a secret's (`process.env`,
 * `process-2.env`), so `readEvidence` also checks the final names.
 */
export function assertNotSecret(file: OutgoingFile, home: string | undefined): void {
  // Labels for the error: a path by its file name only, so no full path is echoed.
  const secrets = (list: ReadonlyArray<string | undefined> | undefined, isName: boolean) =>
    (list ?? []).flatMap((given) => {
      if (!given) return [];
      const shown = isName ? given : basename(given);
      if (isSecretPath(given)) return [shown];
      const forms = [safeFileName(basename(given)), ...(isName ? [safeFileName(given)] : [])];
      const published = forms.find((form) => isSecretPath(form));
      return published ? [`${shown} (published as ${published})`] : [];
    });
  const [label] = [
    ...secrets([file.realPath, ...(file.paths ?? [])], false),
    ...secrets(file.names, true),
  ];
  if (label) {
    throw forbidden(
      `${label} looks like a secrets file (.env, keys, credentials). CodeDen never attaches or shares those, because they would leak secrets. Leave it out and describe what you checked instead.`,
      "secret_file",
    );
  }
  if (file.realPath && home && isCodedenCredentialFile(file.realPath, home)) {
    throw forbidden(
      `${basename(file.realPath)} is one of CodeDen's own credential files, which are never attached or shared.`,
      "secret_file",
    );
  }
}
