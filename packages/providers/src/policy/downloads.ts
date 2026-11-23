import { binName, joinScriptBlocks, unwrap } from "./command-words";
import { type ItemWrites, PARAM, readParams, SWITCHES, valuesOf } from "./item-writes";
import { isTempRoot, type PathContext } from "./paths";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * Where a PowerShell download saves its file (#547), for the outside-the-worktree check
 * (`classifyWrite`, §11.2), judged as `Set-Content` is: `Invoke-WebRequest` and `Invoke-RestMethod`
 * (`iwr`, `irm`, and Windows PowerShell's `curl` and `wget` aliases) with `-OutFile` or a prefix
 * of it (`-OutF`), and `Start-BitsTransfer`'s `-Destination`, named or its second positional word
 * (the first when `-Source` is named). A URL is not a path: an upload's destination
 * (`Start-BitsTransfer -TransferType Upload`) writes nothing here. Fetching itself is judged as
 * before.
 */

const WEB_REQUESTS = new Set([
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
  "curl",
  "wget",
]);
const BITS = "start-bitstransfer";
/** `Start-BitsTransfer`'s switch parameters, which take no value. */
const BITS_SWITCHES = [...SWITCHES, "asynchronous", "suspended", "dynamic"];
/** A URL (`https://…`, `ftp://…`), which names no file here. */
const WEB_ADDRESS = /^[a-z][\w+.-]*:\/\//i;

/**
 * The files `cmd` saves a download to when it is one of the download cmdlets. Saved into a temp
 * folder itself (`Start-BitsTransfer <url> $env:TEMP`), the file is named after the URL, as a copy
 * into temp is judged by the names it copies (a secrets file there asks).
 */
export function downloadWrites(cmd: SimpleCommand, ctx: PathContext): ItemWrites {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = joinScriptBlocks(tokens.slice(1));
  const values = WEB_REQUESTS.has(bin) ? outFiles(args) : bin === BITS ? destinations(args) : [];
  const name = urlName(args.find((a) => WEB_ADDRESS.test(a)));
  const targets = values
    .flatMap((v) => wordPaths(cmd, v))
    .filter((p) => !WEB_ADDRESS.test(p))
    .map((p) => (name && isTempRoot(p, ctx) ? `${p.replace(/[\\/]+$/, "")}/${name}` : p));
  // The words naming them, for the secrets check, which they don't read: `-OutFile:x` too.
  const words = args.filter((a) => values.some((v) => a === v || a.endsWith(`:${v}`)));
  return { targets, words };
}

/** The file name at the end of a URL's path (`https://x/a.zip?v=1` -> `a.zip`), if any. */
function urlName(url: string | undefined): string | undefined {
  const path = url?.replace(/[?#].*$/, "").replace(WEB_ADDRESS, "");
  const name = path?.includes("/") ? path.split("/").pop() : undefined;
  return name || undefined;
}

/** The values of `-OutFile` (or a prefix of it, which PowerShell accepts when unambiguous). */
function outFiles(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const param = PARAM.exec(args[i] as string);
    const name = param?.[1]?.toLowerCase() ?? "";
    if (name.length < 2 || !"outfile".startsWith(name)) continue;
    const value = param?.[2] ?? args[i + 1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** `Start-BitsTransfer`'s destinations: `-Destination`, or the positional word after the source. */
function destinations(args: string[]): string[] {
  const { named, positional } = readParams(args, BITS_SWITCHES);
  const given = valuesOf(named, "destination");
  if (given.length) return given;
  const at = positional[valuesOf(named, "source").length ? 0 : 1];
  return at === undefined ? [] : [at];
}
