import { basename, join, resolve } from "node:path";
import { CODEDEN_CREDENTIAL_FILES } from "@codeden/contracts";
import { isSecretPath } from "@codeden/providers";
import { forbidden } from "./errors";
import { realPathOf } from "./files/path-guard";
import { safeFileName } from "./github/evidence";

/** A file on its way out of the machine, by every name it goes by. */
export interface OutgoingFile {
  /** Its real path (`realPathOf`: links and short names resolved), when it comes from disk. */
  realPath?: string;
  /** Its other names: the path asked for, the name it is published or saved under. */
  names: ReadonlyArray<string | undefined>;
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const comparable = (p: string) => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p));
/** Both sides resolve the same way: symlinks, junctions and short names (`LEON~1`). */
const canonical = (p: string) => comparable(realPathOf(p) ?? p);

/** True when `file` is one of CodeDen's own credential files in `home` (§15). */
export function isCodedenCredentialFile(file: string, home: string): boolean {
  const target = canonical(file);
  return CODEDEN_CREDENTIAL_FILES.some((name) => canonical(join(home, name)) === target);
}

/**
 * Refuse secrets on their way out (§9 Evidence, §15). `attach_evidence` publishes files to
 * GitHub, and `share_to_chat` stores artifacts `attach_evidence` can publish by id. Calls to
 * CodeDen's own tools skip the risk classifier, so these tools check here: a file `isSecretPath`
 * matches by any of its names (`.env`, SSH keys, `.npmrc`, `*.pem`, ...), or one of CodeDen's
 * own credential files in `home`, is refused with `403 secret_file` at every permission level.
 * Each name is also checked as evidence publishes it (`safeFileName`), so `-id_rsa` and
 * `notes.p!em` can't go out as `id_rsa` and `notes.pem`. Evidence then only adds `-2` before
 * the extension to tell files apart, which never turns a name into a secret's.
 */
export function assertNotSecret(file: OutgoingFile, home: string | undefined): void {
  const names = [file.realPath, ...file.names].filter((name): name is string => !!name);
  for (const name of names) {
    const published = safeFileName(basename(name));
    const label = isSecretPath(name)
      ? basename(name)
      : isSecretPath(published)
        ? `${basename(name)} (published as ${published})`
        : undefined;
    if (!label) continue;
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
