import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRow } from "../src/process/inside";
import { endProcessesInside } from "../src/process/worktree-processes";
import { removeWithLeftovers } from "../src/workspace/leftover-processes";
import { emptyTrash } from "../src/workspace/trash";
import { makeRepo, removeDir, sh, tempDir } from "./helpers";

/**
 * Issue #99: on Windows, finished factory items ended with "Couldn't remove the worktree: The
 * worktree is in use". The rows below are the process table captured on the machine that hit
 * it (2026-11-12): the desktop app restarted the runner at 09:42:19, then archived the items
 * that had finished; dev servers the agents had started before the restart still ran in their
 * worktrees, so moving the folders failed. Paths are spelled for the platform the test runs on.
 */
const windows = process.platform === "win32";
const p = (win: string) => (windows ? win : win.replace(/^C:/, "").replace(/\\/g, "/"));

const HOME = p("C:\\Users\\leon\\.codeden");
const SCOUT_WT = p("C:\\Users\\leon\\.codeden\\wt\\codeden\\36e3ead3");
const HOOKS_WT = p("C:\\Users\\leon\\.codeden\\wt\\codeden\\c761f1f5");
const NODE = p("C:\\Program Files\\nodejs\\node.exe");
const BASH = p("C:\\Program Files\\Git\\usr\\bin\\bash.exe");

/** When this (runner) process started, as `endProcessesInside` computes it. */
const RUNNER_STARTED_AT = Date.now() - process.uptime() * 1000;
const MINUTE = 60_000;
const DESKTOP_APP = 47_000;

const row = (pid: number, ppid: number, extra: Partial<ProcessRow>): ProcessRow => ({
  pid,
  ppid,
  exe: null,
  commandLine: null,
  cwd: null,
  startedAt: null,
  ...extra,
});

/** The restarted runner (this process) under the desktop app that started it. */
const codeden: ProcessRow[] = [
  row(DESKTOP_APP, 1, { exe: p("C:\\Program Files\\CodeDen\\CodeDen.exe"), startedAt: 0 }),
  row(process.pid, DESKTOP_APP, { exe: NODE, startedAt: RUNNER_STARTED_AT }),
];

/**
 * `npx vite --port 5291` from the scout-settings builder's shell (#92), 7.5 minutes before the
 * restart, all working in `apps/web`. The agent CLI that started it (24284) went away with the
 * old runner. Only the last one names the worktree on its command line.
 */
function devServer(wt: string): ProcessRow[] {
  const at = RUNNER_STARTED_AT - 7.5 * MINUTE;
  const cwd = `${wt}${p("\\apps\\web\\")}`;
  const npx = `"/c/Program Files/nodejs/npx" vite --port 5291 --strictPort`;
  return [
    row(82416, 24284, { exe: BASH, commandLine: `"${BASH}" ${npx}`, cwd, startedAt: at }),
    row(89224, 82416, { exe: BASH, commandLine: `"${BASH}" ${npx}`, cwd, startedAt: at }),
    row(78096, 89224, {
      exe: NODE,
      commandLine: `"${NODE}" "${p("C:\\Program Files\\nodejs/node_modules/npm/bin/npx-cli.js")}" vite --port 5291 --strictPort`,
      cwd,
      startedAt: at,
    }),
    row(79160, 78096, {
      exe: p("C:\\WINDOWS\\system32\\cmd.exe"),
      commandLine: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --port 5291 --strictPort",
      cwd,
      startedAt: at,
    }),
    row(76632, 79160, {
      exe: NODE,
      commandLine: `node   "${wt}${p("\\apps\\web\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js")}" --port 5291 --strictPort`,
      cwd,
      startedAt: at,
    }),
  ];
}
const DEV_SERVER = [82416, 89224, 78096, 79160, 76632];

/**
 * The hooks builder (#78) ran CodeDen's runner from its worktree with tsx, 1.5 hours before the
 * restart; tsx's esbuild service (an executable inside the worktree) kept the trashed folder.
 */
const tsxStartedAt = RUNNER_STARTED_AT - 90 * MINUTE;
const hooksDevRunner: ProcessRow[] = [
  row(82596, 8956, {
    exe: NODE,
    commandLine: `"${NODE}" --import file:///C:/Users/leon/.codeden/wt/codeden/c761f1f5/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs ${HOOKS_WT}${p("\\apps\\runner\\src\\main.ts")}`,
    startedAt: tsxStartedAt,
  }),
  row(84536, 82596, {
    exe: `${HOOKS_WT}${p("\\node_modules\\.pnpm\\@esbuild+win32-x64@0.28.2\\node_modules\\@esbuild\\win32-x64\\esbuild.exe")}`,
    commandLine: "esbuild.exe --service=0.28.2 --ping",
    startedAt: tsxStartedAt + 5_000,
  }),
];

/**
 * What a person has open in the worktree, never ended: their editor on a file in it, and a
 * dev server they run in their own terminal there.
 */
function usersOwn(wt: string): ProcessRow[] {
  const at = RUNNER_STARTED_AT - 24 * 60 * MINUTE;
  return [
    row(5100, 5000, {
      exe: p("C:\\Users\\leon\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"),
      commandLine: `Code.exe ${wt}${p("\\README.md")}`,
      startedAt: at,
    }),
    row(6000, 5000, {
      exe: p("C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe"),
      startedAt: at,
    }),
    row(6001, 6000, {
      exe: p("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
      cwd: wt,
      startedAt: at,
    }),
    row(6002, 6001, {
      exe: NODE,
      commandLine: `node ${wt}${p("\\server.js")}`,
      cwd: wt,
      startedAt: at,
    }),
  ];
}
const USERS_OWN = [5100, 6000, 6001, 6002];

async function endInside(dir: string, table: ProcessRow[], removing = true): Promise<number[]> {
  const killed: number[] = [];
  await endProcessesInside(dir, {
    home: HOME,
    removing,
    table: async () => table,
    kill: async (pid) => {
      killed.push(pid);
    },
  });
  return killed;
}

describe("removing a worktree after the runner restarted (#99)", () => {
  const table = [...codeden, ...devServer(SCOUT_WT), ...hooksDevRunner, ...usersOwn(SCOUT_WT)];

  it("ends the dev server an agent started in the worktree before the restart", async () => {
    const killed = await endInside(SCOUT_WT, table);
    expect(killed).toEqual(expect.arrayContaining([76632]));
    // With working directories known, its whole chain (shells, npx, cmd) counts too.
    expect(killed.sort((a, b) => a - b)).toEqual([...DEV_SERVER].sort((a, b) => a - b));
  });

  it("never ends the user's editor or terminal there, nor CodeDen", async () => {
    const killed = await endInside(SCOUT_WT, table);
    for (const pid of [...USERS_OWN, process.pid, DESKTOP_APP]) expect(killed).not.toContain(pid);
  });

  it("ends a process running an executable from inside the worktree, started before it", async () => {
    const killed = await endInside(HOOKS_WT, table);
    expect(killed.sort((a, b) => a - b)).toEqual([82596, 84536]);
  });

  it("leaves them alone when a session only stops (its worktree stays)", async () => {
    expect(await endInside(SCOUT_WT, table, false)).toEqual([]);
  });
});

describe("the runner's workspace.remove after a restart (#99)", () => {
  const dirs: string[] = [];
  let home = "";
  afterEach(async () => {
    await emptyTrash(home);
    for (const dir of dirs.splice(0).reverse()) removeDir(dir);
  });

  it("ends what was left running in the worktree, then removes it", async () => {
    const repo = makeRepo();
    home = tempDir("codeden-home-");
    dirs.push(repo, home);
    const wt = join(home, "wt", "demo", "abcd1234");
    mkdirSync(join(home, "wt", "demo"), { recursive: true });
    sh(repo, "worktree", "add", "-q", "-b", "codeden/abcd1234", wt);
    const killed: number[] = [];
    const result = await removeWithLeftovers(
      { name: "workspace.remove", repoPath: repo, path: wt, force: false },
      {
        home,
        supervisor: { killUnder: async () => undefined },
        terminals: { closeUnder: async () => undefined },
        processes: {
          table: async () => [...codeden, ...devServer(wt), ...usersOwn(wt)],
          kill: async (pid) => {
            killed.push(pid);
          },
        },
      },
    );
    expect(killed.sort((a, b) => a - b)).toEqual([...DEV_SERVER].sort((a, b) => a - b));
    expect(result).toEqual({ removed: true });
    expect(existsSync(wt)).toBe(false);
  });
});
