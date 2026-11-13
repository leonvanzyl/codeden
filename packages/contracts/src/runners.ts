import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * Runners the server drives (`docs/remote-runners.md` §8). The
 * home runner is the local one next to the server; later phases add one runner per sandboxed
 * session (Docker, Upstash Box). Each is a row of the `runners` table, projected from the
 * `runner.*` lifecycle events.
 */

/** Record id of the home runner: the local runner next to the server. */
export const HOME_RUNNER_ID = "home";

/**
 * Where a runner runs (its execution backend):
 * - `local`: a process on this machine with worktrees in `<home>/wt` (the home runner);
 * - `docker`: inside a container on this machine (or the Docker host the CLI points at);
 * - `upstash-box`: inside an Upstash Box in the cloud.
 */
export const RunnerBackendId = z.enum(["local", "docker", "upstash-box"]);
export type RunnerBackendId = z.infer<typeof RunnerBackendId>;

/**
 * A runner's lifecycle as the server sees it:
 * - `provisioning`: its sandbox is being made;
 * - `starting`: the runner process is starting or the server is connecting to it;
 * - `connected`: handshake done; commands and events flow;
 * - `disconnected`: the connection dropped; the server is trying again;
 * - `paused`: the sandbox is paused (its disk is kept);
 * - `stopped`: the sandbox or process was stopped on purpose;
 * - `failed`: it could not be provisioned, started or connected (see `lastError`);
 * - `deleted`: the sandbox is gone. The record stays, so its sessions report which runner
 *   they lost instead of falling back to another one.
 */
export const RunnerRecordState = z.enum([
  "provisioning",
  "starting",
  "connected",
  "disconnected",
  "paused",
  "stopped",
  "failed",
  "deleted",
]);
export type RunnerRecordState = z.infer<typeof RunnerRecordState>;

/** One runner the server knows about (a `runners` row). */
export const RunnerRecord = z.object({
  /** CodeDen's id for this runner; `HOME_RUNNER_ID` for the home runner. */
  id: Id,
  backend: RunnerBackendId,
  /** The home runner: provider detection, utility jobs, the orchestrator and PMs use it. */
  home: z.boolean(),
  /**
   * The runner's own id (its journal's, reported in `welcome`); null until it first connects.
   * `sessions.runnerId` holds this id.
   */
  runnerId: z.string().nullable(),
  /** The backend's handle on the sandbox (container id, box id); null for `local`. */
  sandboxRef: z.string().nullable(),
  /** The project and session a sandbox runner serves; null for the home runner. */
  projectId: Id.nullable(),
  sessionId: Id.nullable(),
  state: RunnerRecordState,
  /** CodeDen version the runner reported at its last handshake. */
  version: z.string().nullable(),
  /** Version of the sandbox image or snapshot it was made from; null for `local`. */
  imageVersion: z.string().nullable(),
  createdAt: Timestamp,
  /** When the server last connected to it or lost it. */
  lastSeenAt: Timestamp.nullable(),
  /** Why it last failed or disconnected, safe to show (never contains tokens). */
  lastError: z.string().nullable(),
});
export type RunnerRecord = z.infer<typeof RunnerRecord>;

/** Event payload: the server registered a runner, or re-registered it with new details. */
export const RunnerRegisteredPayload = z.object({ runner: RunnerRecord });

/** Event payload: a runner's sandbox is gone; its record stays with state `deleted`. */
export const RunnerDeletedPayload = z.object({ id: Id });

/**
 * The optional runner record id carried by `runner.connected`, `runner.disconnected` and
 * `runner.draining`. Events stored before several runners existed have none; they belong to
 * the home runner.
 */
export const RunnerRecordRef = { id: Id.optional() };
