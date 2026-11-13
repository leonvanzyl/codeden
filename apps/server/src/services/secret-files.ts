import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CODEDEN_CREDENTIAL_FILES } from "@codeden/contracts";
import { isSecretPath } from "@codeden/providers";
import { forbidden } from "./errors";

/** A file on its way out of the machine, by every name it goes by. */
export interface OutgoingFile {
  /** Its real path (symlinks resolved), when it comes from disk. */
  realPath?: string;
  /** Its other names: the path asked for, the name it is published or saved under. */
  names: ReadonlyArray<string | undefined>;
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const comparable = (p: string) => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p));

function realOrSelf(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** True when `realPath` is one of CodeDen's own credential files in `home` (§15). */
export function isCodedenCredentialFile(realPath: string, home: string): boolean {
  const target = comparable(realPath);
  return CODEDEN_CREDENTIAL_FILES.some((file) => {
    const path = join(home, file);
    return comparable(path) === target || comparable(realOrSelf(path)) === target;
  });
}

/**
 * Refuse secrets on their way out (§9 Evidence, §15). `attach_evidence` publishes files to
 * GitHub, and `share_to_chat` stores artifacts `attach_evidence` can publish by id. Calls to
 * CodeDen's own tools skip the risk classifier, so these tools check here: a file `isSecretPath`
 * matches by any of its names (`.env`, SSH keys, `.npmrc`, `*.pem`, ...), or one of CodeDen's
 * own credential files in `home`, is refused with `403 secret_file` at every permission level.
 */
export function assertNotSecret(file: OutgoingFile, home: string | undefined): void {
  const names = [file.realPath, ...file.names].filter((name): name is string => !!name);
  const secret = names.find((name) => isSecretPath(name));
  if (secret) {
    throw forbidden(
      `${basename(secret)} looks like a secrets file (.env, keys, credentials). CodeDen never attaches or shares those, because they would leak secrets. Leave it out and describe what you checked instead.`,
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
