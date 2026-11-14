import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  RunnerCommandOf,
  RunnerCommandResult,
  RunnerEvent,
  RunnerStream,
} from "@codeden/contracts";
import { defaultShell } from "@codeden/providers";
import type * as NodePty from "node-pty";
import { CommandError } from "../errors";
import { cwdMissing } from "../git/exec";
import { childEnv } from "../process/env";
import type { ProcessSupervisor } from "../process/supervisor";
import { killTree } from "../process/tree";
import { isInside } from "../util/paths";
import { Scrollback } from "./scrollback";

type PtyModule = typeof NodePty;

let cached: PtyModule | null | undefined;

/** Load node-pty once; `null` when its native module is unavailable on this machine. */
export function loadPty(): PtyModule | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    ensureSpawnHelperExecutable(require);
    cached = require("node-pty") as PtyModule;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * On macOS and Linux node-pty forks through a small `spawn-helper` binary next to its native
 * module. Package managers do not always keep its executable bit when they extract the
 * prebuilt tarball, and every terminal then fails with "posix_spawnp failed". Restore it.
 */
function ensureSpawnHelperExecutable(require: NodeJS.Require): void {
  if (process.platform === "win32") return;
  let root: string;
  try {
    root = dirname(require.resolve("node-pty/package.json"));
  } catch {
    return;
  }
  const dirs = ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`];
  for (const dir of dirs) {
    const helper = join(root, dir, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        // read-only install; node-pty reports the spawn failure itself
      }
    }
  }
}

/** Default interactive shell for this platform (shared with the server's setup commands). */
export { defaultShell };

interface Terminal {
  pty: NodePty.IPty;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: Scrollback;
  exited: boolean;
  exitCode: number | null;
}

export interface TerminalHostOptions {
  supervisor: ProcessSupervisor;
  emit: (event: RunnerEvent) => void;
  stream: (stream: RunnerStream) => void;
  maxLines?: number;
  maxChars?: number;
}

/**
 * node-pty terminals owned by the runner (§12.1), so they survive server restarts. Output
 * goes out on the ephemeral stream and into a bounded scrollback replayed on attach;
 * exits are journaled. ConPTY on Windows, forkpty elsewhere.
 */
export class TerminalHost {
  private readonly terminals = new Map<string, Terminal>();

  constructor(private readonly opts: TerminalHostOptions) {}

  get available(): boolean {
    return loadPty() !== null;
  }

  ids(): string[] {
    return [...this.terminals.keys()];
  }

  open(cmd: RunnerCommandOf<"pty.open">): RunnerCommandResult<"pty.open"> {
    const ptyModule = loadPty();
    if (!ptyModule) throw new CommandError("pty_unavailable", "node-pty is not available");
    if (this.terminals.has(cmd.ptyId)) {
      throw new CommandError("pty_exists", `Terminal ${cmd.ptyId} already exists`);
    }
    if (!existsSync(cmd.cwd)) throw cwdMissing(cmd.cwd);
    const pty = ptyModule.spawn(cmd.shell ?? defaultShell(), cmd.args ?? [], {
      name: "xterm-256color",
      cols: cmd.cols,
      rows: cmd.rows,
      cwd: cmd.cwd,
      env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", ...cmd.env }),
    });
    const term: Terminal = {
      pty,
      cwd: resolve(cmd.cwd),
      cols: cmd.cols,
      rows: cmd.rows,
      scrollback: new Scrollback(this.opts.maxLines, this.opts.maxChars),
      exited: false,
      exitCode: null,
    };
    this.terminals.set(cmd.ptyId, term);
    this.opts.supervisor.adopt({ pid: pty.pid, label: `pty ${cmd.ptyId}`, cwd: term.cwd });
    pty.onData((data) => {
      term.scrollback.append(data);
      this.opts.stream({ kind: "pty.output", ptyId: cmd.ptyId, data });
    });
    pty.onExit(({ exitCode }) => {
      term.exited = true;
      term.exitCode = exitCode;
      this.opts.supervisor.release(pty.pid);
      // Closed terminals were killed on purpose; only report exits of live ones.
      if (this.terminals.get(cmd.ptyId) === term) {
        this.opts.emit({ kind: "pty.exited", ptyId: cmd.ptyId, exitCode });
      }
    });
    return { pid: pty.pid };
  }

  input(ptyId: string, data: string): void {
    const term = this.get(ptyId);
    if (term.exited) throw new CommandError("pty_exited", `Terminal ${ptyId} has exited`);
    term.pty.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const term = this.get(ptyId);
    term.cols = cols;
    term.rows = rows;
    if (!term.exited) term.pty.resize(cols, rows);
  }

  attach(ptyId: string): RunnerCommandResult<"pty.attach"> {
    const term = this.get(ptyId);
    return {
      pid: term.pty.pid,
      cols: term.cols,
      rows: term.rows,
      scrollback: term.scrollback.toString(),
      exited: term.exited,
      exitCode: term.exitCode,
    };
  }

  /** Kill the terminal's whole process tree and forget it. */
  async close(ptyId: string): Promise<void> {
    const term = this.get(ptyId);
    this.terminals.delete(ptyId);
    if (!term.exited) await killTree(term.pty.pid, 500);
    this.opts.supervisor.release(term.pty.pid);
    try {
      term.pty.kill(); // releases ConPTY handles even after the shell exited
    } catch {
      // already gone
    }
  }

  /** Close terminals whose cwd is inside `dir` (before removing a worktree). */
  async closeUnder(dir: string): Promise<void> {
    const ids = [...this.terminals.entries()]
      .filter(([, t]) => isInside(dir, t.cwd))
      .map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.ids().map((id) => this.close(id).catch(() => undefined)));
  }

  private get(ptyId: string): Terminal {
    const term = this.terminals.get(ptyId);
    if (!term) throw new CommandError("unknown_pty", `Terminal ${ptyId} not found`);
    return term;
  }
}
