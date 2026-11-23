import { binName, CD, namedArg, unwrap } from "./command-words";
import { type PathContext, providerPath, resolveAgainst, type SavedLocation } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Where relative paths resolve as a command line runs (§11.2). `cd`, `Set-Location` and their kin
 * move the location. A `cd` onto a PowerShell drive that isn't the filesystem (`cd HKCU:\Software`,
 * then `cd Foo`) moves relative paths there (`psDrive`) until a `cd` back to a folder.
 *
 * `pushd` and `Push-Location` save the location they leave on a stack, and `popd` and
 * `Pop-Location` go back to the latest one saved (#541). With nothing saved earlier in the command,
 * the shell's own stack is unknown, so the location stays. Named stacks (`-StackName x`) are kept
 * apart. `Set-Location -StackName x` makes another stack the default, so it forgets the stack and
 * later pops stay where they are.
 *
 * Only a real pop goes back (#550). Plain `popd` and `Pop-Location` (also with `-PassThru`) pop in
 * every shell. Given anything else, shells disagree: bash refuses an unknown argument and stays,
 * `popd -n` stays too, dropping the entry it would go back to, and `popd +N` drops another one
 * (followed by forgetting the stack); PowerShell refuses a parameter it doesn't know and stays; cmd
 * ignores popd's arguments and pops. So such a pop is followed every way it may go, and so is
 * `dirs -c`, which empties bash's stack and is no command elsewhere. The risk classifier judges what
 * comes after in each of these locations (`locationsAfter`).
 */

const PUSH = new Set(["pushd", "push-location"]);
const POP = new Set(["popd", "pop-location"]);

/** The most locations a command line is followed in at once; past it, the command asks. */
export const MAX_LOCATIONS = 16;

/** Every location the shell may be in after `cmd`, from each of `ctxs`, without repeats. */
export function locationsAfter<T extends PathContext>(cmd: SimpleCommand, ctxs: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const next of ctxs.flatMap((ctx) => afterCd(cmd, ctx))) {
    const key = JSON.stringify([next.dir, next.psDrive, next.pushed]);
    if (!seen.has(key)) seen.set(key, next);
  }
  return [...seen.values()];
}

/** The contexts after `cmd` when it changes location (`cd dir`, `Set-Location -Path dir`, `popd`). */
function afterCd<T extends PathContext>(cmd: SimpleCommand, ctx: T): T[] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (bin === "dirs") {
    const clears = tokens.slice(1).some((a) => /^-[lpv]*c[clpv]*$/.test(a));
    return clears
      ? [ctx, { ...ctx, pushed: ctx.pushed?.filter((s) => s.stack !== undefined) }]
      : [ctx];
  }
  if (POP.has(bin)) return afterPop(bin, tokens.slice(1), ctx);
  if (!CD.has(bin)) return [ctx];
  const { stack, args } = withoutStackName(tokens.slice(1));
  if (args.includes("-")) return [ctx];
  const target = namedArg(args, ["-path", "-literalpath"]) ?? args.find((a) => !a.startsWith("-"));
  if (PUSH.has(bin)) {
    const saved: SavedLocation = { dir: ctx.dir, psDrive: ctx.psDrive, stack };
    // With no location, `Push-Location` saves the current one and stays.
    const moved = target === undefined ? ctx : moveTo(target, ctx);
    return [{ ...moved, pushed: [...(ctx.pushed ?? []), saved] }];
  }
  if (stack !== undefined) return [{ ...ctx, pushed: undefined }];
  return [moveTo(target ?? "~", ctx)];
}

/**
 * Where a pop may leave the shell: back to the latest location saved, or where it is. `popd` with
 * arguments may be any shell's, so it is followed both ways, and also with the entry bash's
 * `popd -n` drops or, for `popd +N`, with the stack forgotten.
 */
function afterPop<T extends PathContext>(bin: string, words: string[], ctx: T): T[] {
  const { stack, args } = withoutStackName(words);
  const back = popLocation(ctx, stack);
  // `-PassThru` (a prefix from `-Pa`, or bound, `-PassThru:$false`) only also writes the new
  // location out.
  const passThru = (a: string) => {
    const name = /^-(pa[a-z]*)(?::.*)?$/is.exec(a)?.[1];
    return name !== undefined && "passthru".startsWith(name.toLowerCase());
  };
  if (bin === "pop-location") return args.every(passThru) ? [back] : [ctx, back];
  if (words.length === 0) return [back];
  const out = [ctx, back, popLocation(ctx, undefined)];
  if (args.includes("-n")) out.push(dropLatest(ctx));
  if (args.some((a) => /^[+-]\d+$/.test(a))) out.push({ ...ctx, pushed: undefined });
  return out;
}

/** The context with its location moved to `target`: a folder, or an item on a PowerShell drive. */
export function moveTo<T extends PathContext>(target: string, ctx: T): T {
  const provider = providerPath(target, ctx);
  if (provider && provider.path === undefined) return { ...ctx, psDrive: provider.drive };
  const onDisk = { ...ctx, psDrive: undefined };
  return { ...onDisk, dir: resolveAgainst(provider?.path ?? target, onDisk) };
}

/** Back to the latest location saved on `stack` (the default stack when undefined). */
function popLocation<T extends PathContext>(ctx: T, stack: string | undefined): T {
  const k = latest(ctx, stack);
  if (k < 0) return ctx;
  const saved = ctx.pushed?.[k] as SavedLocation;
  return { ...dropLatest(ctx, stack), dir: saved.dir, psDrive: saved.psDrive };
}

/** The context without the latest location saved on `stack`, staying where it is. */
function dropLatest<T extends PathContext>(ctx: T, stack?: string): T {
  const k = latest(ctx, stack);
  const pushed = ctx.pushed ?? [];
  return k < 0 ? ctx : { ...ctx, pushed: [...pushed.slice(0, k), ...pushed.slice(k + 1)] };
}

/** Where the latest location saved on `stack` is in `ctx.pushed`; -1 for none. */
function latest(ctx: PathContext, stack: string | undefined): number {
  const pushed = ctx.pushed ?? [];
  for (let k = pushed.length - 1; k >= 0; k -= 1) {
    if (pushed[k]?.stack === stack) return k;
  }
  return -1;
}

/**
 * The stack a `-StackName x` names (also a prefix, `-Stack x`, or bound, `-StackName:x`),
 * lower-cased, and the other words.
 */
function withoutStackName(args: string[]): { stack?: string; args: string[] } {
  const rest: string[] = [];
  let stack: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = /^-(s\w*)(?::(.*))?$/is.exec(arg);
    if (param && "stackname".startsWith((param[1] as string).toLowerCase())) {
      i += param[2] === undefined ? 1 : 0;
      stack = (param[2] ?? args[i] ?? "").toLowerCase();
    } else rest.push(arg);
  }
  return { stack, args: rest };
}
