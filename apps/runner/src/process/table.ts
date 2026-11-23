import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { ProcessRow } from "./inside";

/** Run a command for its output. With `partial`, a non-zero exit still returns what it printed. */
function run(file: string, args: string[], timeoutMs = 30_000, partial = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        if (!error || (partial && stdout)) resolve(stdout);
        else reject(error);
      },
    );
  });
}

/** PowerShell: every process with its parent, executable, command line and start time. */
const WINDOWS_QUERY = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; e = $_.ExecutablePath; c = $_.CommandLine; t = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } }) | ConvertTo-Json -Compress",
].join("; ");

const text = (v: unknown) => (typeof v === "string" && v ? v : null);
const time = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** Parse the JSON `WINDOWS_QUERY` prints (an array, or one object for a single process). */
export function parseWindowsTable(json: string): ProcessRow[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((raw) => {
    const r = raw as { p?: unknown; pp?: unknown; e?: unknown; c?: unknown; t?: unknown };
    if (typeof r.p !== "number") return [];
    return [
      {
        pid: r.p,
        ppid: typeof r.pp === "number" ? r.pp : 0,
        exe: text(r.e),
        commandLine: text(r.c),
        cwd: null,
        startedAt: time(r.t),
      },
    ];
  });
}

/**
 * Windows: what WMI lists, without working directories. Windows doesn't report another
 * process's working directory; the only way to get it is to read that process's memory, which
 * CodeDen never does (it needs code compiled at runtime, and antivirus rightly flags both, #608).
 * Processes are matched by executable and command line instead, and, when a session stops, by
 * the process tree (`cutOffByStop`).
 */
async function windowsTable(): Promise<ProcessRow[]> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY];
  return parseWindowsTable(await run("powershell.exe", args));
}

/** Linux: everything from /proc (entries of other users' processes may be unreadable). */
async function linuxTable(): Promise<ProcessRow[]> {
  const stat = await readFile("/proc/stat", "utf8").catch(() => "");
  const bootSeconds = Number(/^btime (\d+)$/m.exec(stat)?.[1] ?? Number.NaN);
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const rows = await Promise.all(
    pids.map(async (name): Promise<ProcessRow | null> => {
      const dir = `/proc/${name}`;
      const line = await readFile(`${dir}/stat`, "utf8").catch(() => "");
      // `pid (comm) state ppid ... starttime ...`; comm may contain spaces and parentheses.
      const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      if (!line || !Number.isFinite(ppid)) return null;
      // Clock ticks after boot; USER_HZ is 100 on every mainstream Linux.
      const ticks = Number(fields[19]);
      const startedAt = Number.isFinite(bootSeconds + ticks)
        ? (bootSeconds + ticks / 100) * 1000
        : null;
      const cmdline = await readFile(`${dir}/cmdline`, "utf8").catch(() => "");
      return {
        pid: Number(name),
        ppid,
        exe: await readlink(`${dir}/exe`).catch(() => null),
        commandLine: cmdline ? cmdline.replace(/\0+$/, "").replace(/\0/g, " ") : null,
        cwd: await readlink(`${dir}/cwd`).catch(() => null),
        startedAt,
      };
    }),
  );
  return rows.filter((r): r is ProcessRow => r !== null);
}

/** Parse `ps -A -ww -o pid=,ppid=,lstart=,command=` output (`lstart`: `Tue Nov 10 17:00:00 2026`). */
export function parsePsTable(output: string): ProcessRow[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*(.*)$/.exec(line);
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        exe: null,
        commandLine: match[4] || null,
        cwd: null,
        startedAt: time(match[3]),
      },
    ];
  });
}

/** Parse `lsof -nP -d cwd -Fpn` output (`p<pid>` then `n<path>` lines) into pid -> cwd. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** macOS and other POSIX systems: `ps` for command lines, `lsof` (best effort) for cwds. */
async function psTable(): Promise<ProcessRow[]> {
  const rows = parsePsTable(await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="]));
  // lsof exits non-zero when it can't read some processes; what it could read still counts.
  const cwds = await run("lsof", ["-nP", "-d", "cwd", "-Fpn"], 20_000, true)
    .then(parseLsofCwds)
    .catch(() => new Map<number, string>());
  return rows.map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? null }));
}

/**
 * The system process table with executables, command lines, start times and (Linux, macOS)
 * cwds. Command lines can hold secrets: they are only matched against paths, never logged or
 * reported.
 */
export function processTable(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return windowsTable();
  if (process.platform === "linux") return linuxTable();
  return psTable();
}
