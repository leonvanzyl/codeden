import { z } from "zod";
import { ErrorInfo, ProviderId, Timestamp } from "../common";
import { ProviderInfo } from "../provider";
import { RunnerBackendId } from "../runners";
import { RunnerCommand, RunnerSessionInfo } from "./commands";
import { RunnerEvent, RunnerStream } from "./events";

/**
 * Server <-> runner protocol (§4.3): JSON messages over one connection, a loopback WebSocket
 * or an exec link (`./link.ts`).
 *
 * Handshake:
 *   1. server -> `hello`   (protocol + server version)
 *   2. runner -> `welcome` (runner id/version/capabilities/providers/sessions) or `reject`
 *   3. server -> `resume`  (last seq it has persisted for this runner id)
 *   4. runner replays journaled events with `seq > lastAckedSeq`, then streams live.
 *
 * After the handshake the server sends `command`s (answered by `result` with the same `id`)
 * and cumulative `ack`s; the runner sends `event`s (durable, with `seq`), `stream`s
 * (ephemeral) and `providers` (the current provider list, whenever it changes). Either side
 * may `ping`.
 */

/** Request id correlating a `command` with its `result`. */
export const RequestId = z.string().min(1).max(100);

/** Monotonic per-runner event sequence number (distinct from the server's event log seq). */
export const RunnerSeq = z.int().positive();

/** Features a runner offers (in addition to provider capabilities). */
export const RunnerCapabilities = z.object({
  pty: z.boolean(),
  browser: z.boolean(),
  git: z.boolean(),
  mcpProxy: z.boolean(),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

const Ping = z.object({ type: z.literal("ping"), id: z.string() });
const Pong = z.object({ type: z.literal("pong"), id: z.string() });

// ---------------------------------------------------------------- server -> runner

export const ServerHello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.int().positive(),
  serverVersion: z.string(),
});

export const ServerResume = z.object({
  type: z.literal("resume"),
  /** Highest runner seq the server has durably stored; 0 when none. */
  lastAckedSeq: z.int().nonnegative(),
});

export const ServerCommand = z.object({
  type: z.literal("command"),
  id: RequestId,
  command: RunnerCommand,
});

/** Cumulative ack: every event with `seq <= seq` may be dropped from the journal. */
export const ServerAck = z.object({ type: z.literal("ack"), seq: RunnerSeq });

export const ServerToRunnerMessage = z.discriminatedUnion("type", [
  ServerHello,
  ServerResume,
  ServerCommand,
  ServerAck,
  Ping,
  Pong,
]);
export type ServerToRunnerMessage = z.infer<typeof ServerToRunnerMessage>;

// ---------------------------------------------------------------- runner -> server

export const RunnerWelcome = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.int().positive(),
  /** Stable id persisted in `<home>/runner/`; survives runner restarts. */
  runnerId: z.string().min(1),
  runnerVersion: z.string(),
  pid: z.int().positive(),
  startedAt: Timestamp,
  capabilities: RunnerCapabilities,
  providers: z.array(ProviderInfo),
  sessions: z.array(RunnerSessionInfo),
  journal: z.object({ lastSeq: z.int().nonnegative(), unacked: z.int().nonnegative() }),
  /** True when the runner is draining and will not accept new sessions. */
  draining: z.boolean(),
  /**
   * The runner machine's OS, as Node.js reports it (`process.platform`: `linux`, `darwin`,
   * `win32`, ...), so the server never guesses path separators. Absent from older runners.
   */
  platform: z.string().min(1).max(40).optional(),
  /** The runner machine's CPU architecture (`process.arch`: `x64`, `arm64`, ...). */
  arch: z.string().min(1).max(40).optional(),
  /** The runner's absolute data directory on its own machine (a sandbox path for a remote one). */
  home: z.string().min(1).max(4096).optional(),
  /** Where the runner runs (`docs/remote-runners.md` §5); `local` for the runner next to the server. */
  backend: RunnerBackendId.optional(),
});
export type RunnerWelcome = z.infer<typeof RunnerWelcome>;

export const RunnerReject = z.object({
  type: z.literal("reject"),
  reason: z.enum(["protocol_mismatch", "busy", "shutting_down"]),
  message: z.string(),
  supportedProtocolVersions: z.array(z.int().positive()).optional(),
});

export const RunnerResult = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("result"), id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal("result"), id: RequestId, ok: z.literal(false), error: ErrorInfo }),
]);
export type RunnerResult = z.infer<typeof RunnerResult>;

export const RunnerEventMessage = z.object({
  type: z.literal("event"),
  seq: RunnerSeq,
  ts: Timestamp,
  event: RunnerEvent,
});
export type RunnerEventMessage = z.infer<typeof RunnerEventMessage>;

export const RunnerStreamMessage = z.object({
  type: z.literal("stream"),
  ts: Timestamp,
  stream: RunnerStream,
});

/**
 * The runner's full, current provider list, replacing the one from `welcome`. Sent after
 * `resume` and whenever a provider's models change (model discovery, a session reporting its
 * models). Ephemeral: not journaled, since the next handshake carries the latest list anyway.
 */
export const RunnerProvidersMessage = z.object({
  type: z.literal("providers"),
  providers: z.array(ProviderInfo),
});
export type RunnerProvidersMessage = z.infer<typeof RunnerProvidersMessage>;

export const RunnerToServerMessage = z.discriminatedUnion("type", [
  RunnerWelcome,
  RunnerReject,
  RunnerResult,
  RunnerEventMessage,
  RunnerStreamMessage,
  RunnerProvidersMessage,
  Ping,
  Pong,
]);
export type RunnerToServerMessage = z.infer<typeof RunnerToServerMessage>;

// ---------------------------------------------------------------- lock file

/**
 * `<home>/runner/runner.json`: how the server finds a live runner again (§4.2).
 * Written by the runner once it is listening; removed on clean exit.
 */
export const RunnerLock = z.object({
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  /** Random token the server must present (`Authorization: Bearer`). */
  token: z.string().min(16),
  version: z.string(),
  protocolVersion: z.int().positive(),
  runnerId: z.string().min(1),
  startedAt: Timestamp,
  providers: z.array(ProviderId).default([]),
});
export type RunnerLock = z.infer<typeof RunnerLock>;

/** `<home>/server.json`: the running server, used by the CLI (`open`, `stop`). */
export const ServerLock = z.object({
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  version: z.string(),
  startedAt: Timestamp,
});
export type ServerLock = z.infer<typeof ServerLock>;
