import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isUserApp, type ProcessRow, withDescendants } from "../src/process/inside";
import { endProcessesInside } from "../src/process/worktree-processes";
import { removeWithLeftovers } from "../src/workspace/leftover-processes";
import { emptyTrash } from "../src/workspace/trash";
import { makeRepo, removeDir, setPlatform, sh, tempDir } from "./helpers";

/**
 * Issue #109: archiving a session removes its worktree, and the removal ended what runs there
 * with the rule made for Windows (#99: whatever runs in the folder, whenever it started, except
 * CodeDen and a person's editor, terminal or file manager). Linux and macOS can delete a folder
 * while processes use it, so there only what CodeDen's agents started is ended, and a person's
 * own shells and dev servers keep running.
 *
 * The process tables below are what the runner reads on those systems (`processTable`), with
 * paths spelled the way they are there. `process.platform` is set for each test, so the suite
 * runs the same on any host.
 */
let realPlatform = () => {};
afterEach(() => realPlatform());

/** When this (runner) process started, as `endProcessesInside` computes it. */
const RUNNER_STARTED_AT = Date.now() - process.uptime() * 1000;
const MINUTE = 60_000;
const BOOT = RUNNER_STARTED_AT - 7 * 24 * 60 * MINUTE;
const HOUR_BEFORE = RUNNER_STARTED_AT - 60 * MINUTE;
const AFTER = RUNNER_STARTED_AT + MINUTE;

const row = (pid: number, ppid: number, extra: Partial<ProcessRow>): ProcessRow => ({
  pid,
  ppid,
  exe: null,
  commandLine: null,
  cwd: null,
  startedAt: null,
  ...extra,
});

/** The worktree as a command line on Linux or macOS names it. */
const slashed = (path: string) => path.replace(/\\/g, "/");

/** A dev server an agent of this runner started in the worktree: always ended. */
const agentsDevServer = (wt: string): ProcessRow[] => [
  row(3001, process.pid, { commandLine: "/bin/bash -c npm run dev", cwd: wt, startedAt: AFTER }),
  row(3002, 3001, {
    commandLine: `node ${slashed(wt)}/node_modules/.bin/vite`,
    cwd: wt,
    startedAt: AFTER + 1_000,
  }),
];
const AGENTS = [3001, 3002];

/**
 * An app an agent opened on the worktree from its shell (a terminal, an editor), with a shell a
 * person works in there and the dev server they run in it. All of it is the agent's by
 * ancestry, but ending the shell would close the app, and the shell and server in it are the
 * person's: none of it is ended.
 */
const inAgentOpenedApp = (wt: string, app: Partial<ProcessRow>): ProcessRow[] => [
  row(3010, process.pid, { commandLine: "/bin/sh -c open .", cwd: wt, startedAt: AFTER }),
  row(3011, 3010, { cwd: wt, startedAt: AFTER, ...app }),
  row(3012, 3011, { commandLine: "/bin/bash", cwd: wt, startedAt: AFTER + MINUTE }),
  row(3013, 3012, {
    commandLine: `node ${slashed(wt)}/server.js`,
    cwd: wt,
    startedAt: AFTER + MINUTE,
  }),
];

/**
 * A Linux dev box CodeDen runs on over SSH. A person has two SSH sessions of their own in the
 * worktree, one opened before CodeDen started and one since, each with a shell and the dev
 * server they run in it, a test watcher in a terminal that isn't on the app list (`foot`) in
 * their desktop session, and a dev server in a terminal an agent opened (`xterm`). With
 * `hidden`, the rows of other users' processes are missing, as when `/proc` is mounted with
 * `hidepid=2`: init, the sshd listener and each session's privileged sshd run as root.
 */
function linux(wt: string, hidden = false): ProcessRow[] {
  const sshd = "/usr/sbin/sshd";
  const session = (pid: number, tty: string, at: number): ProcessRow[] => [
    row(pid, 600, { exe: sshd, commandLine: "sshd: leon [priv]", startedAt: at }),
    row(pid + 1, pid, { exe: sshd, commandLine: `sshd: leon@${tty}`, startedAt: at }),
    row(pid + 2, pid + 1, { exe: "/usr/bin/bash", commandLine: "-bash", cwd: wt, startedAt: at }),
  ];
  const server = (pid: number, ppid: number, at: number) =>
    row(pid, ppid, { exe: "/usr/bin/node", commandLine: "node server.js", cwd: wt, startedAt: at });
  const rows = [
    row(1, 0, { exe: "/usr/lib/systemd/systemd", commandLine: "/sbin/init", startedAt: BOOT }),
    row(600, 1, { exe: sshd, commandLine: "sshd: /usr/sbin/sshd -D [listener]", startedAt: BOOT }),
    // CodeDen, started from one SSH session.
    ...session(618, "pts/1", HOUR_BEFORE).map((r) => (r.pid === 620 ? { ...r, cwd: null } : r)),
    row(47000, 620, {
      exe: "/usr/bin/node",
      commandLine: "node /usr/lib/node_modules/codeden/dist/cli.js",
      startedAt: RUNNER_STARTED_AT - 1_000,
    }),
    row(process.pid, 47000, { exe: "/usr/bin/node", startedAt: RUNNER_STARTED_AT }),
    // The person's own SSH sessions, cd'd into the worktree.
    ...session(610, "pts/0", HOUR_BEFORE),
    server(613, 612, HOUR_BEFORE),
    ...session(630, "pts/2", AFTER),
    server(633, 632, AFTER),
    // The person's desktop session: a test watcher in `foot`.
    row(700, 1, {
      exe: "/usr/lib/systemd/systemd",
      commandLine: "systemd --user",
      startedAt: BOOT,
    }),
    row(710, 700, { exe: "/usr/bin/foot", commandLine: "foot", startedAt: HOUR_BEFORE }),
    row(711, 710, { exe: "/usr/bin/bash", commandLine: "bash", cwd: wt, startedAt: HOUR_BEFORE }),
    row(712, 711, {
      exe: "/usr/bin/node",
      commandLine: `node ${slashed(wt)}/node_modules/.bin/vitest --watch`,
      cwd: wt,
      startedAt: HOUR_BEFORE,
    }),
    ...inAgentOpenedApp(wt, { exe: "/usr/bin/xterm", commandLine: "xterm" }),
    ...agentsDevServer(wt),
  ];
  const root = new Set([1, 600, 610, 618, 630]);
  return hidden ? rows.filter((r) => !root.has(r.pid)) : rows;
}

/**
 * CodeDen in a dev container, started from `docker exec -it dev bash`. The person attached a
 * shell the same way and runs a dev server in the worktree, and, since CodeDen started, attached
 * their editor, which runs a terminal there. Each `docker exec` process has parent pid 0 inside
 * the container (its parent lives outside it), so they share no ancestor with the runner.
 */
function container(wt: string): ProcessRow[] {
  const vscode = "/root/.vscode-server/bin/0f0d87fa9e96c856c5212fc86db137ac0d783365";
  return [
    row(1, 0, { exe: "/usr/bin/sleep", commandLine: "sleep infinity", startedAt: BOOT }),
    row(20, 0, { exe: "/usr/bin/bash", commandLine: "bash", startedAt: HOUR_BEFORE }),
    row(47000, 20, {
      exe: "/usr/local/bin/node",
      commandLine: "node /usr/local/lib/node_modules/codeden/dist/cli.js",
      startedAt: RUNNER_STARTED_AT - 1_000,
    }),
    row(process.pid, 47000, { exe: "/usr/local/bin/node", startedAt: RUNNER_STARTED_AT }),
    // `docker exec -it dev bash`, then `cd` into the worktree and `node server.js`.
    row(30, 0, { exe: "/usr/bin/bash", commandLine: "bash", cwd: wt, startedAt: HOUR_BEFORE }),
    row(31, 30, {
      exe: "/usr/local/bin/node",
      commandLine: `node ${slashed(wt)}/server.js`,
      cwd: wt,
      startedAt: HOUR_BEFORE,
    }),
    // The editor's server in the container, its terminal host, and a terminal in the worktree.
    row(40, 0, { exe: "/bin/sh", commandLine: `sh ${vscode}/bin/code-server`, startedAt: AFTER }),
    row(41, 40, {
      exe: `${vscode}/node`,
      commandLine: "node out/server-main.js",
      startedAt: AFTER,
    }),
    row(42, 41, {
      exe: `${vscode}/node`,
      commandLine: "node out/bootstrap-fork",
      startedAt: AFTER,
    }),
    row(43, 42, { exe: "/usr/bin/bash", commandLine: "/bin/bash", cwd: wt, startedAt: AFTER }),
    row(44, 43, {
      exe: "/usr/local/bin/node",
      commandLine: `node ${slashed(wt)}/node_modules/.bin/vite`,
      cwd: wt,
      startedAt: AFTER,
    }),
    ...agentsDevServer(wt),
  ];
}

/**
 * A Mac running the CodeDen desktop app. `ps` reports no executable paths, only command lines.
 * The person runs a dev server in a terminal of their editor in the worktree, and has an SSH
 * session there (sshd is started for each connection by launchd). An agent opened the editor on
 * the worktree from its shell, and the person runs a dev server in a terminal of that one too.
 */
const VS_CODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
function mac(wt: string): ProcessRow[] {
  const helper =
    "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";
  return [
    row(1, 0, { commandLine: "/sbin/launchd", startedAt: BOOT }),
    row(47000, 1, {
      commandLine: "/Applications/CodeDen.app/Contents/MacOS/CodeDen",
      startedAt: RUNNER_STARTED_AT - 1_000,
    }),
    row(process.pid, 47000, { commandLine: "node runner.js", startedAt: RUNNER_STARTED_AT }),
    row(1000, 1, { commandLine: VS_CODE, startedAt: HOUR_BEFORE }),
    row(1001, 1000, { commandLine: `${helper} --type=utility`, startedAt: HOUR_BEFORE }),
    row(1002, 1001, { commandLine: "/bin/zsh -il", cwd: wt, startedAt: HOUR_BEFORE }),
    row(1003, 1002, { commandLine: "node server.js", cwd: wt, startedAt: HOUR_BEFORE }),
    row(1100, 1, { commandLine: "/usr/sbin/sshd -i", startedAt: HOUR_BEFORE }),
    row(1101, 1100, { commandLine: "sshd: leon [priv]", startedAt: HOUR_BEFORE }),
    row(1102, 1101, { commandLine: "sshd: leon@ttys003", startedAt: HOUR_BEFORE }),
    row(1103, 1102, { commandLine: "-zsh", cwd: wt, startedAt: HOUR_BEFORE }),
    ...inAgentOpenedApp(wt, { commandLine: `${VS_CODE} ${slashed(wt)}` }),
    ...agentsDevServer(wt),
  ];
}

describe("removing a worktree on Linux and macOS (#109)", () => {
  let repo = "";
  let home = "";
  let count = 0;
  beforeAll(() => {
    repo = makeRepo();
    home = tempDir("codeden-home-");
  });
  afterAll(async () => {
    await emptyTrash(home);
    removeDir(repo);
    removeDir(home);
  });

  /**
   * Archive a session on `platform`: `workspace.remove` on its worktree, with `table` as the
   * process table. Returns what was ended, with everything under it (tree kills).
   */
  async function archive(
    platform: NodeJS.Platform,
    table: (wt: string) => ProcessRow[],
  ): Promise<number[]> {
    count += 1;
    const short = `abcd${String(count).padStart(4, "0")}`;
    const wt = join(home, "wt", "demo", short);
    mkdirSync(join(home, "wt", "demo"), { recursive: true });
    sh(repo, "worktree", "add", "-q", "-b", `codeden/${short}`, wt);
    const rows = table(wt);
    const killed: number[] = [];
    realPlatform = setPlatform(platform);
    const result = await removeWithLeftovers(
      { name: "workspace.remove", repoPath: repo, path: wt, force: false },
      {
        home,
        supervisor: { killUnder: async () => undefined },
        terminals: { closeUnder: async () => undefined },
        processes: {
          table: async () => rows,
          kill: async (pid) => {
            killed.push(pid);
          },
        },
      },
    );
    expect(result).toEqual({ removed: true });
    return [...withDescendants(killed, rows)].sort((a, b) => a - b);
  }

  it("Linux: never ends a person's SSH shell or terminal, nor their work in one an agent opened", async () => {
    expect(await archive("linux", (wt) => linux(wt))).toEqual(AGENTS);
  });

  it("Linux, other users' processes hidden (hidepid): the same", async () => {
    expect(await archive("linux", (wt) => linux(wt, true))).toEqual(AGENTS);
  });

  it("Linux in a container: never ends a person's `docker exec` shell or editor terminal", async () => {
    expect(await archive("linux", container)).toEqual(AGENTS);
  });

  it("macOS: never ends a person's terminal or SSH shell, nor an editor an agent opened or their work in it", async () => {
    expect(await archive("darwin", mac)).toEqual(AGENTS);
  });
});

describe("a session stopping on Linux (#109)", () => {
  const wt = "/home/leon/.codeden/wt/demo/abcd1234";
  /** The agent exited: its dev server was adopted by init (hidden here, with `hidepid`). */
  const orphan = [
    row(3101, 1, { commandLine: `node ${wt}/server.js`, cwd: wt, startedAt: AFTER }),
    row(3102, 3101, { commandLine: "node vite", cwd: wt, startedAt: AFTER }),
  ];
  async function stop(seen: number[]): Promise<number[]> {
    const rows = [...linux(wt, true), ...orphan];
    const killed: number[] = [];
    realPlatform = setPlatform("linux");
    await endProcessesInside(wt, {
      home: "/home/leon/.codeden",
      seen: new Set(seen),
      table: async () => rows,
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    return [...withDescendants(killed, rows)].sort((a, b) => a - b);
  }

  it("ends what its agent started, seen before it stopped, never a person's", async () => {
    expect(await stop([3101, 3102])).toEqual([...AGENTS, 3101, 3102]);
    // A parent missing from the table is one the runner can't see, not one that exited.
    expect(await stop([])).toEqual(AGENTS);
    // What runs in an app the agent opened stays, also when it was seen as the agent's.
    expect(await stop([3010, 3011, 3012, 3013, 3101, 3102])).toEqual([...AGENTS, 3101, 3102]);
  });
});

describe("recognising an app from its command line alone, as on macOS (#109)", () => {
  const wt = "/Users/leon/.codeden/wt/demo/abcd1234";
  const app = (commandLine: string) => isUserApp(row(1, 0, { commandLine }), wt, false);

  it("reads an app bundle's program whole, also with spaces in its path", () => {
    expect(app(`${VS_CODE} --inspect=0`)).toBe(true);
    expect(app(`"${VS_CODE}" ${wt}`)).toBe(true);
    expect(app(`${VS_CODE} ${wt}/README.md`)).toBe(true);
    expect(app("/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron")).toBe(
      true,
    );
    expect(
      app(
        "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer) --type=renderer",
      ),
    ).toBe(true);
    expect(app("/usr/local/bin/nvim README.md")).toBe(true);
  });

  it("never takes a bundle named in the arguments, or one built in the worktree, for one", () => {
    expect(app(`/bin/zsh -c ${VS_CODE}`)).toBe(false);
    expect(app(`/usr/bin/open ${VS_CODE}`)).toBe(false);
    expect(app(`/bin/zsh "${VS_CODE}"`)).toBe(false);
    expect(app(`${wt}/dist/My App.app/Contents/MacOS/My App`)).toBe(false);
    expect(app("/bin/zsh -il")).toBe(false);
  });
});
