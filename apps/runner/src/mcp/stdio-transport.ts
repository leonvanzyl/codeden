/// <reference path="../types/cross-spawn.d.ts" />
import type { ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import spawn from "cross-spawn";

export interface McpStdioParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  onStderr: (chunk: string) => void;
}

/**
 * MCP over a child process's stdin and stdout, for connection tests (§12.4).
 *
 * It only talks to the process and never stops it: the test stops the whole tree it started,
 * on every path. So the pid is kept from spawn to the end, even after the process has exited
 * or the client has closed the transport, and on POSIX the process leads its own process
 * group, which still reaches what it started after it is gone. `cross-spawn` runs `.cmd`
 * shims such as `npx` on Windows.
 */
export class McpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** The server process, from spawn on; null when it could not be started. */
  pid: number | null = null;
  private child: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly params: McpStdioParams) {}

  start(): Promise<void> {
    if (this.child) throw new Error("Already started");
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args, {
        cwd: this.params.cwd,
        env: this.params.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => {
        this.pid = child.pid ?? null;
        resolve();
      });
      child.once("close", () => {
        this.child = null;
        this.onclose?.();
      });
      child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.params.onStderr(chunk.toString("utf8")));
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.on("error", (error) => this.onerror?.(error));
      }
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Detach from the process; stopping it is the caller's job (see the class comment). */
  async close(): Promise<void> {
    this.child = null;
    this.buffer.clear();
  }

  private read(chunk: Buffer): void {
    try {
      this.buffer.append(chunk);
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        // A line that isn't JSON-RPC (a log line on stdout) is reported and skipped.
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }
}
