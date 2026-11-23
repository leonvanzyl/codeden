import type { RiskAssessment } from "./assessment";
import {
  codedenAccess,
  credentialsRisk,
  forReading,
  touchesCodedenCredentials,
  touchesCodedenHome,
} from "./codeden-home";
import { listsCodedenHome, reachesHomeThroughFolder, reachesThroughFolder } from "./codeden-search";
import { binName, CD, DISCARD, unwrap } from "./command-words";
import type { PathContext } from "./paths";
import { onlyReads } from "./read-only";
import { secretArgument } from "./secrets";
import { type SimpleCommand, type WordPaths, wordPaths } from "./shell";

/** How a verdict names what was touched in CodeDen's home (`codedenAccess`). */
export const CODEDEN_WHAT = {
  credentials: "CodeDen's own credentials",
  home: "CodeDen's own home",
} as const;

/** The paths each word of `cmd` may stand for: itself, and a PowerShell list's elements. */
export const pathsOf =
  (cmd: SimpleCommand): WordPaths =>
  (word, from) =>
    wordPaths(cmd, word, from);

/**
 * One simple command's access to CodeDen's home (§11.2, #320), its credentials first: a
 * redirect onto a path there, any argument (or here-string) that reaches one (read, written,
 * copied or deleted), a listing of a folder there, or a search or listing that reaches it from a
 * folder above (`./codeden-search`). The session's own worktree under the home is not part of
 * it, nor, for a command that only reads (`onlyReads`) and whose output feeds no other command,
 * its own artifacts folder (`forReading`, #338): output handed on could name files there to a
 * command that writes or deletes them. Moving into the home with `cd` reads nothing; the command
 * that then reads is caught. `feeds`: the command's output is used by another command (a pipe or
 * a substitution).
 */
export function codedenCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
  feeds: boolean,
): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  for (const target of cmd.writes) {
    const access = DISCARD.test(target) ? undefined : codedenAccess(target, ctx);
    if (access) return credentialsRisk(`Writes ${CODEDEN_WHAT[access]}: ${target}`);
  }
  for (const word of cmd.input ?? []) {
    const access = codedenAccess(word, ctx);
    if (access) return credentialsRisk(`Passes ${CODEDEN_WHAT[access]}: ${word}`);
  }
  // A file PowerShell's variable syntax reads (`${C:\Users\me\.codeden\codeden.db}`).
  for (const item of cmd.reads ?? []) {
    const access = codedenAccess(item, feeds ? ctx : forReading(ctx));
    if (access) return credentialsRisk(`Reads ${CODEDEN_WHAT[access]}: ${item}`);
  }
  if (CD.has(bin)) return undefined;
  const paths = pathsOf(cmd);
  const reads = (a: string) => touchesCodedenCredentials(a, ctx);
  const touched = secretArgument(bin, args, [], reads, paths);
  if (touched) return credentialsRisk(`Accesses CodeDen's own credentials: ${touched}`);
  const through = reachesThroughFolder(bin, args, ctx, feeds, paths);
  if (through) return credentialsRisk(`Reaches CodeDen's own credentials from ${through}`);
  const home = !feeds && onlyReads(bin, args) ? forReading(ctx) : ctx;
  const inHome = (a: string) => touchesCodedenHome(a, home);
  const opened = secretArgument(bin, args, [], inHome, paths);
  if (opened) return credentialsRisk(`Accesses CodeDen's own home: ${opened}`);
  const listed = listsCodedenHome(bin, args, home);
  if (listed) return credentialsRisk(`Lists CodeDen's own home: ${listed}`);
  const below = reachesHomeThroughFolder(bin, args, home, feeds, paths);
  return below ? credentialsRisk(`Reaches CodeDen's own home from ${below}`) : undefined;
}
