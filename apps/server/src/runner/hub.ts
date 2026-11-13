import type {
  RunnerBackendId,
  RunnerConnectionStatus,
  RunnerRecord,
  RunnerRecordState,
  RunnerStream,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";
import {
  findRunnerByRunnerId,
  findRunnerRecord,
  listRunnerRecords,
} from "../events/runner-projection";
import type { EventStore } from "../events/store";
import { ServiceError } from "../services/errors";
import { type RunnerPort, type RunnerRouter, runnerPort } from "../services/runner-port";
import { RunnerClient } from "./client";
import type { RunnerLaunchConfig, RunnerStartTimeouts } from "./launcher";
import type { ExecLinkConfig } from "./transport-exec";

/** A runner to drive: its record and how to reach it. */
export interface RunnerSpec {
  /** Record id (`runners.id`); `HOME_RUNNER_ID` for the home runner. */
  id: string;
  backend: RunnerBackendId;
  /** The home runner: global work (providers, utility jobs, orchestrator, PMs) goes to it. */
  home?: boolean;
  /**
   * Reach it through an exec link (`codeden runner-link` started next to it, e.g. with
   * `docker exec -i`) instead of the loopback WebSocket in its lock file.
   */
  link?: ExecLinkConfig;
  /** The runner's data directory, and its lock file (`<dir>/runner/runner.json`); loopback. */
  dir: string;
  lockFile: string;
  /** Loopback: how to start it when none is live; `null` only attaches to a running one. */
  launch: RunnerLaunchConfig | null;
  sandboxRef?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  imageVersion?: string | null;
  startTimeouts?: RunnerStartTimeouts;
}

export interface RunnerHubOptions {
  db: Db;
  store: EventStore;
  /** The server's MCP endpoint, pushed to each runner after its handshake (read at `add`). */
  mcpUpstreamUrl?: () => string | undefined;
  /** Any runner's connection changed. */
  onStatus?: () => void;
  /** Ephemeral stream data from any runner (terminal output, browser frames). */
  onStream?: (stream: RunnerStream) => void;
  /** A current runner connected and is configured; `runnerId` is its journal id. */
  onReady?: (runnerId: string) => void;
  drainTimeoutMs?: number;
  /** No command to any runner gives up sooner than this (`RunnerClientOptions`). */
  requestTimeoutFloorMs?: number;
  log?: (message: string) => void;
}

/** What the UI is told about runners: the home runner's connection, and every runner. */
export interface RunnersStatus {
  runner: RunnerConnectionStatus;
  runners: RunnerRecord[];
}

interface Entry {
  spec: RunnerSpec;
  client: RunnerClient;
  port: RunnerPort;
}

const DISABLED: RunnerConnectionStatus = {
  state: "disabled",
  runnerId: null,
  version: null,
  providers: [],
  lastError: null,
};

/**
 * Every runner the server drives (`docs/remote-runners.md` §8), one `RunnerClient` each: the
 * home runner next to the server and, in later phases, one per sandboxed session. Routes a
 * session to the runner in `sessions.runnerId`. A session with no runner yet, or one whose
 * runner id no record carries (sessions from before records existed, a home runner whose
 * journal was reset), goes to the home runner. A session whose own runner is gone fails with
 * `runner_unavailable` naming that runner, never silently on another one.
 */
export class RunnerHub implements RunnerRouter {
  private readonly entries = new Map<string, Entry>();
  private readonly homePort: RunnerPort;
  private closed = false;

  constructor(private readonly opts: RunnerHubOptions) {
    this.homePort = runnerPort(() => this.homeClient());
  }

  /**
   * Create a runner's client (`start` it next), registering the runner first (a
   * `runner.registered` event) when it is new, was deleted or changed. Re-adding an unchanged
   * runner, such as the home runner on every server start, appends nothing.
   */
  add(spec: RunnerSpec): RunnerClient {
    if (this.closed) throw new Error("The runner hub is closed");
    if (this.entries.has(spec.id)) throw new Error(`Runner ${spec.id} is already added`);
    const previous = findRunnerRecord(this.opts.db, spec.id);
    const record: RunnerRecord = {
      id: spec.id,
      backend: spec.backend,
      home: spec.home ?? false,
      runnerId: previous?.runnerId ?? null,
      sandboxRef: spec.sandboxRef ?? null,
      projectId: spec.projectId ?? null,
      sessionId: spec.sessionId ?? null,
      state: "starting",
      version: previous?.version ?? null,
      imageVersion: spec.imageVersion ?? null,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      lastSeenAt: previous?.lastSeenAt ?? null,
      lastError: null,
    };
    if (!previous || previous.state === "deleted" || detailsChanged(previous, record)) {
      this.opts.store.append([
        { type: "runner.registered", sessionId: null, payload: { runner: record } },
      ]);
    }
    // Errors name the runner with its journal id, read when they happen: the client learns it on
    // connecting, the record keeps it from earlier connections.
    const describe = record.home
      ? undefined
      : () => {
          const runnerId =
            client.status.runnerId ?? findRunnerRecord(this.opts.db, spec.id)?.runnerId ?? null;
          return describeRunner({ ...record, runnerId }, true);
        };
    const log = this.opts.log;
    const client: RunnerClient = new RunnerClient({
      recordId: spec.id,
      describe,
      // Only the home runner, next to the server, is trusted; any other may be a sandbox's.
      untrusted: !record.home,
      link: spec.link,
      home: spec.dir,
      lockFile: spec.lockFile,
      db: this.opts.db,
      store: this.opts.store,
      launch: spec.launch,
      mcpUpstreamUrl: this.opts.mcpUpstreamUrl?.(),
      startTimeouts: spec.startTimeouts,
      drainTimeoutMs: this.opts.drainTimeoutMs,
      requestTimeoutFloorMs: this.opts.requestTimeoutFloorMs,
      onStatus: () => this.opts.onStatus?.(),
      onStream: (stream) => this.opts.onStream?.(stream),
      onReady: (runnerId) => this.opts.onReady?.(runnerId),
      log: log && ((message) => log(record.home ? message : `[${spec.id}] ${message}`)),
    });
    this.entries.set(spec.id, { spec, client, port: runnerPort(() => client, describe) });
    return client;
  }

  /**
   * Disconnect from a runner and forget it; `deleted` also marks its record deleted. A
   * connection still in flight is cancelled first, so nothing is recorded after `deleted`.
   */
  async remove(id: string, opts: { deleted?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    await entry?.client.stop();
    if (opts.deleted) {
      this.opts.store.append([{ type: "runner.deleted", sessionId: null, payload: { id } }]);
    }
    this.opts.onStatus?.();
  }

  /** The client of a runner by record id. */
  client(id: string): RunnerClient | undefined {
    return this.entries.get(id)?.client;
  }

  /** The home runner's client, if one is configured. */
  homeClient(): RunnerClient | undefined {
    for (const entry of this.entries.values()) if (entry.spec.home) return entry.client;
    return undefined;
  }

  home(): RunnerPort {
    return this.homePort;
  }

  forSession(sessionId: string): RunnerPort {
    const row = this.opts.db
      .select({ runnerId: sessions.runnerId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row?.runnerId ? this.forRunnerId(row.runnerId) : this.homePort;
  }

  /** The runner with this journal id; the home runner when no other record carries it. */
  forRunnerId(runnerId: string): RunnerPort {
    const record = findRunnerByRunnerId(this.opts.db, runnerId);
    if (!record || record.home) return this.homePort;
    const entry = this.entries.get(record.id);
    if (entry && record.state !== "deleted") return entry.port;
    return unavailablePort(record);
  }

  /** The home runner's connection and every runner record with its live state. */
  status(): RunnersStatus {
    return { runner: this.homeClient()?.status ?? DISABLED, runners: this.list() };
  }

  /** Every runner record, the home runner first, with live state from its client. */
  list(): RunnerRecord[] {
    return listRunnerRecords(this.opts.db).map((record) => {
      const client = this.entries.get(record.id)?.client;
      if (client) return withLiveStatus(record, client.status);
      // No client: whatever was projected last, but never "connected".
      return record.state === "connected" || record.state === "starting"
        ? { ...record, state: "disconnected" }
        : record;
    });
  }

  /**
   * Disconnect from every runner, cancelling connections still in flight; `stopHome` also asks
   * the home runner process to exit. No runner can be added afterwards.
   */
  async close(opts: { stopHome?: boolean } = {}): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.values()].map(({ spec, client }) =>
        spec.home && opts.stopHome ? client.shutdownRunner() : client.stop(),
      ),
    );
  }
}

/** "Runner rn-1 (docker)", with its journal id when known: for errors and logs. */
export function describeRunner(record: RunnerRecord, withRunnerId = false): string {
  const id = withRunnerId && record.runnerId ? `, runner ${record.runnerId}` : "";
  return `Runner ${record.id} (${record.backend}${id})`;
}

/** A port for a runner the server has no client for: every command fails, naming it. */
function unavailablePort(record: RunnerRecord): RunnerPort {
  const name = describeRunner(record, true);
  return {
    describe: () => name,
    isConnected: () => false,
    runnerId: () => record.runnerId,
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => false,
    request: () =>
      Promise.reject(
        new ServiceError(503, "runner_unavailable", `${name} is not available (${record.state})`),
      ),
  };
}

/** Whether what the server set up about a runner differs (not its live state). */
function detailsChanged(a: RunnerRecord, b: RunnerRecord): boolean {
  return (
    a.backend !== b.backend ||
    a.home !== b.home ||
    a.sandboxRef !== b.sandboxRef ||
    a.projectId !== b.projectId ||
    a.sessionId !== b.sessionId ||
    a.imageVersion !== b.imageVersion
  );
}

const LIVE_STATE: Record<RunnerConnectionStatus["state"], RunnerRecordState> = {
  disabled: "stopped",
  starting: "starting",
  connected: "connected",
  disconnected: "disconnected",
  incompatible: "failed",
};

function withLiveStatus(record: RunnerRecord, status: RunnerConnectionStatus): RunnerRecord {
  return {
    ...record,
    state: LIVE_STATE[status.state],
    runnerId: status.runnerId ?? record.runnerId,
    version: status.version ?? record.version,
    lastError: status.lastError,
  };
}
