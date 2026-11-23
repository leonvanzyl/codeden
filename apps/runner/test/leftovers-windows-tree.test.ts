import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutOffByStop } from "../src/process/cut-off";
import { type ProcessRow, withDescendants } from "../src/process/inside";
import { processesStillInside } from "../src/process/worktree-processes";
import { stopWithLeftovers } from "../src/workspace/leftover-processes";
import { setPlatform } from "./helpers";

/**
 * Issue #608: Windows doesn't report another process's working directory, and CodeDen no longer
 * reads it from the process's memory (antivirus flagged that as malware). What a session's agent
 * left running in its worktree is told by the process tree instead: what the stop cuts off from
 * the runner's tree. The tables are scripted; `process.platform` reads "win32" while the tests
 * run, so the rule is Windows' on every host.
 */
const windows = process.platform === "win32";
let realPlatform = () => {};
beforeAll(() => {
  realPlatform = setPlatform("win32");
});
afterAll(() => realPlatform());
const p = (win: string) => (windows ? win : win.replace(/^C:/, "").replace(/\\/g, "/"));

const HOME = p("C:\\Users\\me\\.codeden");
const WT_A = join(HOME, "wt", "demo", "aaaa1111");
const WT_B = join(HOME, "wt", "demo", "bbbb2222");
const NODE = p("C:\\Program Files\\nodejs\\node.exe");
const BASH = p("C:\\Program Files\\Git\\usr\\bin\\bash.exe");

/** When this (runner) process started, as `endProcessesInside` computes it. */
const RUNNER_STARTED_AT = Date.now() - process.uptime() * 1000;
const RUNNER = process.pid;
const TERMINAL = 500;

const row = (pid: number, ppid: number, extra: Partial<ProcessRow> = {}): ProcessRow => ({
  pid,
  ppid,
  exe: null,
  commandLine: null,
  cwd: null,
  startedAt: RUNNER_STARTED_AT + pid,
  ...extra,
});

/** No working directories and no paths naming either worktree: only the tree can tell. */
const before: ProcessRow[] = [
  row(47_000, 1, { exe: p("C:\\Program Files\\CodeDen\\CodeDen.exe"), startedAt: 0 }),
  row(RUNNER, 47_000, { exe: NODE, startedAt: RUNNER_STARTED_AT }),
  // Session A's agent, with a shell running a dev server and a Python server ...
  row(300, RUNNER, { exe: p("C:\\Users\\me\\.local\\bin\\claude.exe") }),
  row(301, 300, { exe: BASH }),
  row(302, 301, { exe: NODE, commandLine: "node server.js" }),
  row(303, 301, { exe: p("C:\\Python313\\python.exe"), commandLine: "python -m http.server" }),
  // ... and a shell that opened an editor.
  row(305, 300, { exe: BASH }),
  row(306, 305, { exe: p("C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe") }),
  // Session B's agent; its shell exits while A stops, leaving a dev server.
  row(400, RUNNER, { exe: p("C:\\Users\\me\\.local\\bin\\claude.exe") }),
  row(401, 400, { exe: BASH }),
  row(402, 401, { exe: NODE, commandLine: "node server.js" }),
  // A CodeDen terminal; its shell exits while A stops, leaving what was started from it.
  row(TERMINAL, RUNNER, { exe: p("C:\\Program Files\\PowerShell\\7\\pwsh.exe") }),
  row(501, TERMINAL, { exe: NODE }),
  // A dev server that left the tree before the stop: its shell had already exited.
  row(601, 600, { exe: NODE, commandLine: "node server.js" }),
];
const gone = new Set([300, 401, TERMINAL]);
const after = before.filter((r) => !gone.has(r.pid));

describe("what a session's stop cuts off from the runner's tree (#608)", () => {
  it("counts the branches of the agent that exited, nothing else", () => {
    const cut = cutOffByStop({ before, after, runnerPid: RUNNER, tracked: new Set([TERMINAL]) });
    // Not 402 (its agent, 400, still runs), 501 (under a terminal), nor 601 (already detached).
    expect([...cut].sort((a, b) => a - b)).toEqual([301, 302, 303, 305, 306]);
  });

  it("never counts a reused pid, or a process whose start time is unknown", () => {
    const reused = after.map((r) => (r.pid === 302 ? { ...r, startedAt: RUNNER_STARTED_AT } : r));
    expect(cutOffByStop({ before, after: reused, runnerPid: RUNNER })).not.toContain(302);
    const unknown = before.map((r) => (r.pid === 303 ? { ...r, startedAt: null } : r));
    expect(cutOffByStop({ before: unknown, after, runnerPid: RUNNER })).not.toContain(303);
    // Without the runner's start time the tree can't be checked: nothing counts.
    const noRunner = before.filter((r) => r.pid !== RUNNER);
    expect(cutOffByStop({ before: noRunner, after, runnerPid: RUNNER }).size).toBe(0);
  });
});

describe("stopping a session on Windows (#608)", () => {
  /** Stop `sessionId` (A's or B's), the tables switching to `after` once `stop` runs. */
  function harness() {
    const state = { stopped: false };
    const killed: number[] = [];
    const ctx = {
      home: HOME,
      supervisor: { list: () => [{ pid: TERMINAL, label: "pty", cwd: WT_A }] },
      cwds: () =>
        new Map([
          ["a", WT_A],
          ["b", WT_B],
        ]),
      processes: {
        table: async () => (state.stopped ? after : before),
        kill: async (pid: number) => {
          killed.push(pid);
        },
      },
    };
    /** What the tree kills end (`taskkill /T` follows parent pids). */
    const ended = () => [...withDescendants(killed, after)].sort((a, b) => a - b);
    return { state, ctx, ended };
  }

  it("ends what the agent left in its worktree, never a person's editor", async () => {
    const { state, ctx, ended } = harness();
    await stopWithLeftovers(ctx, "a", async () => {
      state.stopped = true;
    });
    // 305 opened the editor (306): ending its tree would close the editor.
    expect(ended()).toEqual([301, 302, 303]);
  });

  it("ends nothing it can't tell apart when another stop overlaps", async () => {
    const { state, ctx, ended } = harness();
    await stopWithLeftovers(ctx, "a", () =>
      stopWithLeftovers(ctx, "b", async () => {
        state.stopped = true;
      }),
    );
    expect(ended()).toEqual([]);
  });
});

describe("naming a process in a message or the log", () => {
  it("names its program alone, never its arguments, which can hold secrets", async () => {
    const script = join(WT_A, "server.js");
    const rows = [
      row(701, 1, { commandLine: `"${NODE}" ${script} --token=s3cret` }),
      row(702, 1, { commandLine: `node ${script} --token=s3cret` }),
      // A quote that doesn't close: where the program ends can't be told.
      row(703, 1, { commandLine: `"${NODE} ${script} --token=s3cret` }),
    ];
    expect(await processesStillInside(WT_A, async () => rows)).toEqual([
      "node.exe (701)",
      "node (702)",
      "? (703)",
    ]);
  });
});
