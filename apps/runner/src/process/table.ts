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
 * PowerShell: `pid<TAB>cwd` for every process whose working directory can be read. Windows
 * doesn't report it, so it is read from the process's own parameters block (64-bit and 32-bit
 * processes of the same user; others are skipped).
 */
const WINDOWS_CWDS = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class CodedenCwd {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr Exit; public IntPtr Peb; public IntPtr Mask; public IntPtr Priority; public IntPtr Id; public IntPtr Parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref Basic b, int l, out int r);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, out IntPtr w, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr n, out IntPtr r);
  static byte[] Read(IntPtr h, long at, int n) {
    byte[] b = new byte[n]; IntPtr r;
    return ReadProcessMemory(h, new IntPtr(at), b, new IntPtr(n), out r) && r.ToInt64() == n ? b : null;
  }
  static string Cwd(int pid) {
    IntPtr h = OpenProcess(0x1010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      IntPtr wow; int r; int len; long buf;
      if (NtQueryInformationProcess(h, 26, out wow, IntPtr.Size, out r) != 0) return null;
      if (wow != IntPtr.Zero) {
        byte[] p = Read(h, wow.ToInt64() + 0x10, 4); if (p == null) return null;
        byte[] s = Read(h, BitConverter.ToUInt32(p, 0) + 0x24L, 8); if (s == null) return null;
        len = BitConverter.ToUInt16(s, 0); buf = BitConverter.ToUInt32(s, 4);
      } else {
        Basic b = new Basic();
        if (NtQueryInformationProcess(h, 0, ref b, Marshal.SizeOf(b), out r) != 0) return null;
        byte[] p = Read(h, b.Peb.ToInt64() + 0x20, 8); if (p == null) return null;
        byte[] s = Read(h, BitConverter.ToInt64(p, 0) + 0x38, 16); if (s == null) return null;
        len = BitConverter.ToUInt16(s, 0); buf = BitConverter.ToInt64(s, 8);
      }
      if (len == 0 || len % 2 != 0) return null;
      byte[] t = Read(h, buf, len);
      return t == null ? null : Encoding.Unicode.GetString(t);
    } finally { CloseHandle(h); }
  }
  public static string[] All() {
    List<string> o = new List<string>();
    if (IntPtr.Size != 8) return o.ToArray();
    foreach (Process p in Process.GetProcesses()) {
      try { string d = Cwd(p.Id); if (d != null) o.Add(p.Id + "\\t" + d); } catch { } finally { p.Dispose(); }
    }
    return o.ToArray();
  }
}
'@
[CodedenCwd]::All()`;

/** Parse the `pid<TAB>cwd` lines `WINDOWS_CWDS` prints into pid -> cwd. */
export function parseWindowsCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    const pid = Number(line.slice(0, tab));
    const cwd = line.slice(tab + 1);
    if (tab > 0 && Number.isInteger(pid) && cwd) cwds.set(pid, cwd);
  }
  return cwds;
}

/** PowerShell arguments that run `script` as is (no quoting to get wrong). */
function powershell(script: string): string[] {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

async function windowsTable(): Promise<ProcessRow[]> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY];
  const [rows, cwds] = await Promise.all([
    run("powershell.exe", args).then(parseWindowsTable),
    // Best effort, like lsof: without them processes are still matched by executable and
    // command line.
    run("powershell.exe", powershell(WINDOWS_CWDS))
      .then(parseWindowsCwds)
      .catch(() => new Map<number, string>()),
  ]);
  return rows.map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? null }));
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

/** The system process table with executables, command lines, start times and (POSIX) cwds. */
export function processTable(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return windowsTable();
  if (process.platform === "linux") return linuxTable();
  return psTable();
}
