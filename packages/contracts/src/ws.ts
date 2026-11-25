import { z } from "zod";
import { ErrorInfo, Id, Timestamp } from "./common";
import { Automation } from "./entities/automation";
import { InboxItem } from "./entities/inbox";
import { Project } from "./entities/project";
import { ItemRecord, Session, Thread, Turn } from "./entities/session";
import { RawEventEnvelope } from "./events";
import { RoleSessionsRef } from "./orchestration";
import { ProviderInfo } from "./provider";
import { RunnerRecord } from "./runners";
import { Settings } from "./settings";
import { UpdateStatus } from "./updates";
import { ScheduledRun } from "./work";

/**
 * Server <-> UI realtime protocol (§6 "Realtime to the UI").
 *
 * 1. The client loads a `Snapshot` over HTTP (`GET /api/snapshot`); it includes the current `seq`.
 * 2. It opens `/ws` and sends `subscribe { fromSeq: snapshot.seq }`.
 * 3. The server sends every event with `seq > fromSeq` (catch-up), then live `events` batches.
 * 4. On reconnect the client subscribes from the last `seq` it applied.
 * 5. If the server cannot serve the gap, it sends `resync`; the client reloads the snapshot.
 */

/** Runner connection state as seen by the server. */
export const RunnerConnectionStatus = z.object({
  state: z.enum(["disabled", "starting", "connected", "disconnected", "incompatible"]),
  runnerId: z.string().nullable(),
  version: z.string().nullable(),
  providers: z.array(ProviderInfo),
  lastError: z.string().nullable(),
  /** False when an attached runner has missed its application-level pong deadline. */
  responsive: z.boolean().optional(),
});
export type RunnerConnectionStatus = z.infer<typeof RunnerConnectionStatus>;

/** The snapshot carries sessions archived in the last this many days... */
export const SNAPSHOT_ARCHIVED_SESSIONS_DAYS = 7;
/** ...and at most this many of them, the most recently archived. */
export const SNAPSHOT_ARCHIVED_SESSIONS_MAX = 100;

/** Everything the app shell needs on load. Transcripts are loaded per session. */
export const Snapshot = z.object({
  seq: z.int().nonnegative(),
  serverVersion: z.string(),
  generatedAt: Timestamp,
  settings: Settings,
  projects: z.array(Project),
  /**
   * Every session that isn't archived, plus the recently archived ones
   * (`SNAPSHOT_ARCHIVED_SESSIONS_DAYS`, at most `SNAPSHOT_ARCHIVED_SESSIONS_MAX`), oldest first.
   * Older archived sessions are fetched when needed: one by id (`GET /api/sessions/:id`), or a
   * project's a page at a time (`GET /api/projects/:id/sessions/archived`). So a live
   * `session.updated` for a session the client doesn't have is one archived before that window.
   */
  sessions: z.array(Session),
  /**
   * How many archived agent sessions each project has, by project id: all of them, not only
   * those in `sessions`. Projects without any are left out.
   */
  archivedSessionCounts: z.record(Id, z.int().nonnegative()).default({}),
  inbox: z.array(InboxItem),
  automations: z.array(Automation),
  /** Upcoming scheduled runs across projects (§8.4 Now / Next). */
  scheduled: z.array(ScheduledRun).default([]),
  /** The orchestrator and PM sessions (§8.1), also present in `sessions`. */
  roleSessions: RoleSessionsRef.optional(),
  /** The home runner's connection, the one the shell shows (§4.2). */
  runner: RunnerConnectionStatus,
  /** Every runner the server drives, the home runner first, with its live state. */
  runners: z.array(RunnerRecord).default([]),
});
export type Snapshot = z.infer<typeof Snapshot>;

/**
 * One session's transcript (`GET /api/sessions/:id/snapshot`): the whole session, or with
 * `SessionSnapshotQuery.turns` the latest root turns only (and the subagent threads they hold).
 */
export const SessionSnapshot = z.object({
  seq: z.int().nonnegative(),
  session: Session,
  threads: z.array(Thread),
  turns: z.array(Turn),
  items: z.array(ItemRecord),
  /**
   * Root-thread turns that started before the earliest one included, left out of this snapshot
   * (load them with `before`). Always 0 for the whole session.
   */
  earlierTurns: z.int().nonnegative().default(0),
  /** The owning root turn of a deep link outside the latest page, with its subagent threads. */
  focused: z
    .object({
      threads: z.array(Thread),
      turns: z.array(Turn),
      items: z.array(ItemRecord),
    })
    .optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

// ---------------------------------------------------------------- client -> server

export const ClientSubscribe = z.object({
  type: z.literal("subscribe"),
  /** Deliver events with `seq > fromSeq`. */
  fromSeq: z.int().nonnegative(),
  /** Restrict to these sessions (plus global events); omitted means everything. */
  sessionIds: z.array(Id).optional(),
});

export const ClientToServerMessage = z.discriminatedUnion("type", [
  ClientSubscribe,
  z.object({ type: z.literal("unsubscribe") }),
  z.object({ type: z.literal("ping"), id: z.string() }),
]);
export type ClientToServerMessage = z.infer<typeof ClientToServerMessage>;

// ---------------------------------------------------------------- server -> client

export const ServerToClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.int().positive(),
    serverVersion: z.string(),
    /** Current head of the event log. */
    seq: z.int().nonnegative(),
  }),
  /**
   * Ordered batch of events. Payloads are sent raw; parse with `EventEnvelope` and skip
   * unknown types so older clients survive newer servers.
   */
  z.object({ type: z.literal("events"), events: z.array(RawEventEnvelope) }),
  /** The client must reload its snapshot and resubscribe from `seq`. */
  z.object({
    type: z.literal("resync"),
    reason: z.enum(["gap", "too_far_behind", "server_restarted"]),
    seq: z.int().nonnegative(),
  }),
  /**
   * A runner's connection changed (ephemeral; not in the event log). `runner` is the home
   * runner's status; `runners` lists every runner with its live state.
   */
  z.object({
    type: z.literal("runner"),
    runner: RunnerConnectionStatus,
    runners: z.array(RunnerRecord).optional(),
  }),
  /** Update check or self-update progress changed (ephemeral; not in the event log, §16). */
  z.object({ type: z.literal("update"), update: UpdateStatus }),
  z.object({ type: z.literal("pong"), id: z.string() }),
  z.object({ type: z.literal("error"), error: ErrorInfo }),
]);
export type ServerToClientMessage = z.infer<typeof ServerToClientMessage>;

/** `GET /api/health` response (unauthenticated, used by the CLI to find a running server). */
export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal("codeden"),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
