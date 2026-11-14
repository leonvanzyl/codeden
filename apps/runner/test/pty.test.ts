import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, type RunningRunner, Scrollback, startRunner } from "../src";
import { loadPty } from "../src/pty/terminal-host";
import { removeDir, TestServer, tempDir, waitUntil } from "./helpers";

describe("Scrollback", () => {
  it("keeps everything under the limits", () => {
    const sb = new Scrollback(10, 1000);
    sb.append("a\nb\n");
    sb.append("c");
    expect(sb.toString()).toBe("a\nb\nc");
    expect(sb.size).toEqual({ chars: 5, lines: 2 });
  });

  it("drops the oldest lines past the line limit", () => {
    const sb = new Scrollback(3, 1000);
    for (let i = 1; i <= 10; i++) sb.append(`line ${i}\n`);
    expect(sb.toString()).toBe("line 8\nline 9\nline 10\n");
    sb.append("x\ny\nz\nw\n");
    expect(sb.toString()).toBe("y\nz\nw\n");
    expect(sb.size.lines).toBe(3);
  });

  it("drops the oldest characters past the size limit", () => {
    const sb = new Scrollback(1000, 10);
    sb.append("0123456789");
    sb.append("abcde");
    expect(sb.toString()).toBe("56789abcde");
    sb.append("x".repeat(25));
    expect(sb.toString()).toBe("x".repeat(10));
    expect(sb.size.chars).toBe(10);
  });
});

const isWindows = process.platform === "win32";
const shell = isWindows ? "cmd.exe" : "/bin/sh";
const node = `"${process.execPath}"`;

describe.skipIf(!loadPty())("terminals (node-pty)", () => {
  let home: string;
  let runner: RunningRunner;
  let server: TestServer;

  beforeEach(async () => {
    home = tempDir("codeden-pty-");
    runner = await startRunner({ home });
    server = await TestServer.attach(runner);
  });
  afterEach(async () => {
    await server.close();
    await runner.close();
    removeDir(home);
  });

  const output = (ptyId: string) =>
    server.messages
      .flatMap((m) =>
        m.type === "stream" && m.stream.kind === "pty.output" && m.stream.ptyId === ptyId
          ? [m.stream.data]
          : [],
      )
      .join("");

  it(`runs an interactive shell (${isWindows ? "ConPTY" : "forkpty"}), replays scrollback and kills the tree`, async () => {
    const welcome = server.messages.find((m) => m.type === "welcome");
    expect(welcome?.type === "welcome" && welcome.capabilities.pty).toBe(true);

    const opened = await server.request({
      name: "pty.open",
      ptyId: "t1",
      cwd: home,
      shell,
      cols: 100,
      rows: 30,
    });
    expect(opened.pid).toBeGreaterThan(0);
    await server.request({ name: "pty.input", ptyId: "t1", data: "echo hello-from-pty\r" });
    await waitUntil(
      () =>
        /hello-from-pty[\s\S]*hello-from-pty/.test(output("t1")) ||
        /\r?\nhello-from-pty/.test(output("t1")),
      20_000,
    );

    await server.request({ name: "pty.resize", ptyId: "t1", cols: 120, rows: 40 });
    const status = await server.request({ name: "runner.status" });
    expect(status.ptys).toEqual(["t1"]);

    // A long-running grandchild under the shell must die with the terminal.
    await server.request({
      name: "pty.input",
      ptyId: "t1",
      data: `${node} -e "console.log('child-pid:'+process.pid);setInterval(()=>{},1000)"\r`,
    });
    await waitUntil(() => /child-pid:\d+/.test(output("t1")), 20_000);
    const childPid = Number(/child-pid:(\d+)/.exec(output("t1"))?.[1]);
    expect(isAlive(childPid)).toBe(true);

    // A reconnecting view gets the bounded scrollback.
    const attached = await server.request({ name: "pty.attach", ptyId: "t1" });
    expect(attached).toMatchObject({ cols: 120, rows: 40, exited: false, pid: opened.pid });
    expect(attached.scrollback).toContain("hello-from-pty");
    expect(attached.scrollback).toContain("child-pid:");

    await server.request({ name: "pty.close", ptyId: "t1" });
    await waitUntil(() => !isAlive(childPid), 10_000);
    await expect(server.request({ name: "pty.attach", ptyId: "t1" })).rejects.toMatchObject({
      code: "unknown_pty",
    });
  }, 60_000);

  it("journals the exit code when the shell exits", async () => {
    const args = isWindows ? ["/c", "exit 7"] : ["-c", "exit 7"];
    await server.request({
      name: "pty.open",
      ptyId: "t2",
      cwd: home,
      shell,
      args,
      cols: 80,
      rows: 24,
    });
    const exited = await server.waitFor(
      (m) => m.type === "event" && m.event.kind === "pty.exited" && m.event.ptyId === "t2",
      20_000,
    );
    expect(
      exited.type === "event" && exited.event.kind === "pty.exited" && exited.event.exitCode,
    ).toBe(7);
    const attached = await server.request({ name: "pty.attach", ptyId: "t2" });
    expect(attached).toMatchObject({ exited: true, exitCode: 7 });
    await expect(
      server.request({ name: "pty.input", ptyId: "t2", data: "x" }),
    ).rejects.toMatchObject({ code: "pty_exited" });
    await server.request({ name: "pty.close", ptyId: "t2" });
    await expect(
      server.request({
        name: "pty.open",
        ptyId: "t3",
        cwd: `${home}/missing`,
        shell,
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "cwd_missing" });
  }, 60_000);
});
