import { rmSync } from "node:fs";
import {
  CODEDEN_VERSION,
  RUNNER_PROTOCOL_VERSION,
  type RunnerLock,
  RunnerToServerMessage,
} from "@codeden/contracts";
import WebSocket from "ws";
import { readLock } from "./lock";
import { isAlive, killTree, waitForExit } from "./process/tree";

/**
 * Ask a runner to shut down over its protocol (`hello` + `runner.shutdown`), so it closes
 * sessions and kills its process trees itself. Resolves true when the request was accepted.
 */
export function requestShutdown(lock: RunnerLock, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/runner`, {
      headers: { authorization: `Bearer ${lock.token}` },
    });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => undefined);
      ws.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          serverVersion: CODEDEN_VERSION,
        }),
      );
    });
    ws.on("message", (data) => {
      const parsed = RunnerToServerMessage.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "welcome") {
        ws.send(
          JSON.stringify({ type: "command", id: "shutdown", command: { name: "runner.shutdown" } }),
        );
      } else if (msg.type === "reject") {
        done(false);
      } else if (msg.type === "result" && msg.id === "shutdown") {
        done(msg.ok);
      }
    });
    ws.on("error", () => done(false));
  });
}

/**
 * Stop the runner for a home (`codeden stop`): graceful shutdown request first, then a
 * process-tree kill if it is still alive. Returns the stopped pid, or undefined when no
 * runner was running.
 */
export async function stopRunner(
  lockFile: string,
  timeoutMs = 10_000,
): Promise<number | undefined> {
  const lock = readLock(lockFile);
  if (!lock || !isAlive(lock.pid)) return undefined;
  if ((await requestShutdown(lock)) && (await waitForExit(lock.pid, timeoutMs))) return lock.pid;
  await killTree(lock.pid);
  await waitForExit(lock.pid, 5_000);
  // A killed runner cannot remove its own lock file.
  if (readLock(lockFile)?.pid === lock.pid) rmSync(lockFile, { force: true });
  return lock.pid;
}
