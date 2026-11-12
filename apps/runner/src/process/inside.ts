/** One row of the system process table, with what each platform can tell about it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Full path of the executable, when readable. */
  exe: string | null;
  /** The full command line, when readable. */
  commandLine: string | null;
  /** Working directory, when readable (on Windows, read from the process's memory). */
  cwd: string | null;
  /** When the process started (ms since the epoch), where the platform reports it. */
  startedAt: number | null;
}

/** Path form for comparing: forward slashes, no trailing slash, lowercase on Windows. */
function norm(path: string, windows: boolean): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? slashed.toLowerCase() : slashed;
}

/**
 * True when `path` is `dir` or inside it. Never true for a sibling whose name merely starts
 * with the folder's name (`.../abcd1234-2` is not inside `.../abcd1234`).
 */
export function pathIsInside(dir: string, path: string, windows: boolean): boolean {
  const d = norm(dir, windows);
  const p = norm(path, windows);
  return d !== "" && (p === d || p.startsWith(`${d}/`));
}

/** Characters that continue a path name: a match preceded by one is part of another path. */
const NAME_CHAR = /[\w.\-~]/;

/**
 * True when a command line names a file or folder inside `dir` (`<dir>/...`): a script, a
 * binary, a config. Naming the folder itself doesn't count (an editor opened on it), nor does
 * a longer path that merely contains it (`D:\copy\C:\wt\...`) or a sibling (`.../abcd1234-2`).
 * On Windows the Git Bash form (`/c/Users/...`) counts too.
 */
export function commandLineNamesInside(
  dir: string,
  commandLine: string,
  windows: boolean,
): boolean {
  const d = norm(dir, windows);
  if (!d) return false;
  const line = windows ? commandLine.replace(/\\/g, "/").toLowerCase() : commandLine;
  const forms = [d];
  const drive = /^([a-z]):\/(.*)$/.exec(d);
  if (windows && drive) forms.push(`/${drive[1]}/${drive[2]}`);
  for (const form of forms) {
    const needle = `${form}/`;
    for (let at = line.indexOf(needle); at !== -1; at = line.indexOf(needle, at + 1)) {
      const before = at === 0 ? "" : (line[at - 1] ?? "");
      if (before && (NAME_CHAR.test(before) || before === "/")) continue;
      const next = line[at + needle.length] ?? "";
      if (next && !/[\s"']/.test(next)) return true;
    }
  }
  return false;
}

/**
 * Whether a process runs from or in `dir`: its executable is inside, its working directory is
 * the folder or inside it, or its command line names something inside it.
 */
export function runsInside(dir: string, row: ProcessRow, windows: boolean): boolean {
  if (row.exe && pathIsInside(dir, row.exe, windows)) return true;
  if (row.cwd && pathIsInside(dir, row.cwd, windows)) return true;
  return row.commandLine !== null && commandLineNamesInside(dir, row.commandLine, windows);
}

/** `pid` and every ancestor of it in the table (stopping at loops and unknown parents). */
export function withAncestors(pid: number, rows: readonly ProcessRow[]): Set<number> {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const out = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 0 && !out.has(p); ) {
    out.add(p);
    p = parent.get(p);
  }
  return out;
}

/** `roots` and all their descendants in the table. */
export function withDescendants(roots: Iterable<number>, rows: readonly ProcessRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  }
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (out.has(pid)) continue;
    out.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Processes CodeDen's agents (or terminals) started: the runner's descendants, plus whatever
 * descends from a process that lost its parent after the runner started, such as the shell an
 * agent ran a dev server in, left behind when the agent exited. Only rows with start times can
 * be judged orphaned (a parent missing, or younger than its child: a reused pid), so a user's
 * own long-running programs, whose parents went away before the runner started, never count.
 */
export function startedByAgents(
  rows: readonly ProcessRow[],
  runnerPid: number,
  runnerStartedAt: number,
): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const roots = [runnerPid];
  for (const r of rows) {
    if (r.startedAt === null || r.startedAt < runnerStartedAt) continue;
    const parent = byPid.get(r.ppid);
    const orphaned = !parent || (parent.startedAt !== null && parent.startedAt > r.startedAt);
    if (orphaned) roots.push(r.pid);
  }
  const out = withDescendants(roots, rows);
  out.delete(runnerPid);
  return out;
}

export interface RemovalOptions {
  rows: readonly ProcessRow[];
  runnerPid: number;
  /** CodeDen's own processes (the runner, the server); see `SelectOptions.protect`. */
  protect: readonly number[];
  /** The folder being deleted (an app run from inside it is not a user app). */
  dir: string;
  windows: boolean;
}

/**
 * Processes that may be ended so a folder can be deleted, whenever they started: everything
 * but CodeDen's own processes and what a person started from an app they work in. Each one's
 * ancestry is followed up to the first process that decides:
 * - the runner: an agent started it;
 * - CodeDen or one of its ancestors (the server, the CLI, the desktop app): CodeDen's own;
 * - an app a person works in (`isUserApp`): the person's, like a dev server in their terminal;
 * - a parent that is gone, or younger than its child (a reused pid): whoever started it is
 *   gone, like a dev server an agent started before the runner restarted.
 */
export function endableForRemoval(opts: RemovalOptions): Set<number> {
  const byPid = new Map(opts.rows.map((r) => [r.pid, r]));
  const codeden = new Set<number>();
  for (const pid of opts.protect) for (const p of withAncestors(pid, opts.rows)) codeden.add(p);
  const verdicts = new Map<number, boolean>();
  const endable = (row: ProcessRow): boolean => {
    const chain = new Set<number>();
    let verdict = true;
    for (let current: ProcessRow | undefined = row; current; ) {
      const known = verdicts.get(current.pid);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      if (current.pid === opts.runnerPid) break;
      if (codeden.has(current.pid) || isUserApp(current, opts.dir, opts.windows)) {
        verdict = false;
        break;
      }
      chain.add(current.pid);
      const parent = byPid.get(current.ppid);
      if (!parent || chain.has(parent.pid)) break;
      const { startedAt } = current;
      if (parent.startedAt !== null && startedAt !== null && parent.startedAt > startedAt) break;
      current = parent;
    }
    for (const pid of chain) verdicts.set(pid, verdict);
    return verdict;
  };
  return new Set(opts.rows.filter(endable).map((r) => r.pid));
}

export interface SelectOptions {
  /** The folder whose processes are ended. */
  dir: string;
  rows: readonly ProcessRow[];
  windows: boolean;
  /**
   * CodeDen's own processes (the runner, the server). They, and every ancestor of theirs, are
   * never chosen: ending an ancestor's process tree would take them down with it.
   */
  protect: readonly number[];
  /** Only these processes may be chosen (see `startedByAgents`). */
  allowed: ReadonlySet<number>;
  /** Processes never chosen (the user's own terminals and what runs in them). */
  spare?: ReadonlySet<number>;
}

/**
 * The processes inside `dir` that may be ended, by pid. Each is ended with its whole tree
 * (`killTree`), so a process is never chosen when anything that must survive runs under it: it
 * is an ancestor of CodeDen (`protect`), of an app a person works in (an editor opened from a
 * shell in the folder), or of a spared terminal. Ancestry is followed by parent pid, as tree
 * kills do.
 */
export function processesToEnd(opts: SelectOptions): number[] {
  const kept = [
    ...opts.protect,
    ...opts.rows.filter((r) => isUserApp(r, opts.dir, opts.windows)).map((r) => r.pid),
    ...(opts.spare ?? []),
  ];
  const safe = new Set<number>();
  for (const pid of kept) for (const p of withAncestors(pid, opts.rows)) safe.add(p);
  return opts.rows
    .filter((r) => r.pid > 0 && !safe.has(r.pid))
    .filter((r) => opts.allowed.has(r.pid))
    .filter((r) => runsInside(opts.dir, r, opts.windows))
    .map((r) => r.pid);
}

/**
 * Apps a person works in: editors, IDEs, terminals and file managers. One may have a file of
 * the worktree open (and look orphaned once its launcher exits), but ending it would close the
 * user's other windows and lose unsaved work, so it is never chosen, whoever started it.
 */
const USER_APPS = new Set([
  "code",
  "code - insiders",
  "codium",
  "cursor",
  "windsurf",
  "zed",
  "fleet",
  "sublime_text",
  "subl",
  "notepad",
  "notepad++",
  "devenv",
  "idea",
  "idea64",
  "webstorm",
  "webstorm64",
  "pycharm",
  "pycharm64",
  "rider",
  "rider64",
  "goland",
  "goland64",
  "clion",
  "clion64",
  "phpstorm",
  "phpstorm64",
  "rubymine",
  "rubymine64",
  "studio",
  "studio64",
  "emacs",
  "vim",
  "gvim",
  "nvim",
  "nvim-qt",
  "nano",
  "explorer",
  "windowsterminal",
  "wt",
  "mintty",
  "conemu",
  "conemu64",
  "tabby",
  "hyper",
  "alacritty",
  "wezterm",
  "wezterm-gui",
  "kitty",
  "ghostty",
  "warp",
  "iterm2",
  "terminal",
  "gnome-terminal-server",
  "konsole",
  "xterm",
  "tmux",
  "screen",
]);

/** The program a process runs (its executable, else the command line's first word). */
function programPath(row: ProcessRow): string | null {
  if (row.exe) return row.exe;
  const line = row.commandLine?.trim();
  if (!line) return null;
  return line.startsWith('"')
    ? line.slice(1, line.indexOf('"', 1))
    : (line.split(/\s+/)[0] ?? null);
}

/** Whether `row` is an app a person works in (see `USER_APPS`), outside the worktree. */
export function isUserApp(row: ProcessRow, dir: string, windows: boolean): boolean {
  const path = programPath(row);
  if (!path || pathIsInside(dir, path, windows)) return false;
  // A macOS app bundle (`Foo.app/Contents/MacOS/Foo`), such as an editor built on Electron.
  if (/\.app\/Contents\/MacOS\//.test(path)) return true;
  const name = path
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|app)$/, "");
  return name !== undefined && USER_APPS.has(name);
}
