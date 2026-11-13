import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "../util/exec";
import type { AcpIncoming, AcpRequestId } from "./protocol";

/** JSON-RPC "method not found": what an agent gets for a request CodeDen doesn't handle. */
export const METHOD_NOT_FOUND = -32601;

/** A JSON-RPC error from the agent, or one CodeDen answers an agent request with. */
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export interface AcpRpcHandlers {
  onNotification: (message: AcpIncoming) => void;
  /** Agent -> client request; resolve with the result, or throw (an `AcpRpcError`) to refuse. */
  onRequest: (message: AcpIncoming) => Promise<unknown>;
  onExit: (code: number | null, stderrTail: string) => void;
}

/**
 * JSON-RPC 2.0 over an ACP agent's stdio: one JSON message per line on stdin and stdout, logs
 * on stderr (kept as a short tail for error reports, never parsed). Ids of CodeDen's requests
 * are numbers it allocates; the agent's own request ids are echoed back as they came.
 */
export class AcpRpc {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private stderrTail = "";
  private exited = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: AcpRpcHandlers,
    private readonly label = "agent",
  ) {
    const stdout = child.stdout;
    if (!stdout || !child.stdin) throw new Error(`${label} needs piped stdio`);
    createInterface({ input: stdout }).on("line", (line) => this.onLine(line));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (error) => {
      this.stderrTail += `\n${error.message}`;
      this.onExit(null);
    });
  }

  get isClosed(): boolean {
    return this.exited;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(new AcpRpcError(-32000, `${this.label} is not running`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Stop the agent: close stdin, then kill the process tree if it lingers. */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(() => resolve(), 5000).unref();
    });
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!this.exited) killTree(this.child);
    }, 1500).unref();
    return exited;
  }

  private write(message: object): void {
    if (this.exited) return;
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Not a protocol message (a stray print); ignore it.
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === "string") {
      void this.answer(msg.id as AcpRequestId, { method: msg.method, params: msg.params });
    } else if (hasId) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      const error = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (error) {
        pending.reject(
          new AcpRpcError(error.code ?? -32000, error.message ?? "Request failed", error.data),
        );
      } else {
        pending.resolve(msg.result);
      }
    } else if (typeof msg.method === "string") {
      this.handlers.onNotification({ method: msg.method, params: msg.params });
    }
  }

  private async answer(id: AcpRequestId, message: AcpIncoming): Promise<void> {
    try {
      const result = await this.handlers.onRequest(message);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const code = error instanceof AcpRpcError ? error.code : -32603;
      this.write({ jsonrpc: "2.0", id, error: { code, message: text } });
    }
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const error = new AcpRpcError(-32000, `${this.label} exited (code ${code ?? "unknown"})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.handlers.onExit(code, this.stderrTail);
  }
}
