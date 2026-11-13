import { describe, expect, it } from "vitest";
import {
  CODEDEN_VERSION,
  defaultSettings,
  EventEnvelope,
  HOME_RUNNER_ID,
  RunnerBackendId,
  RunnerRecord,
  ServerToClientMessage,
  Snapshot,
} from "../src";
import { ts } from "./fixtures";

/** Parse, serialize to JSON and parse again; the result must be stable. */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const home: RunnerRecord = {
  id: HOME_RUNNER_ID,
  backend: "local",
  home: true,
  runnerId: "r-home",
  sandboxRef: null,
  projectId: null,
  sessionId: null,
  state: "connected",
  version: CODEDEN_VERSION,
  imageVersion: null,
  createdAt: ts,
  lastSeenAt: ts,
  lastError: null,
};

const sandbox: RunnerRecord = {
  ...home,
  id: "rn-1",
  backend: "docker",
  home: false,
  runnerId: null,
  sandboxRef: "c0ffee",
  projectId: "p1",
  sessionId: "s1",
  state: "provisioning",
  version: null,
  imageVersion: CODEDEN_VERSION,
  lastSeenAt: null,
};

describe("runner records", () => {
  it("round-trips the home runner and a sandbox runner", () => {
    roundTrip(RunnerRecord, home);
    roundTrip(RunnerRecord, sandbox);
  });

  it("knows the three backends and refuses others", () => {
    expect(RunnerBackendId.options).toEqual(["local", "docker", "upstash-box"]);
    expect(RunnerRecord.safeParse({ ...sandbox, backend: "ssh" }).success).toBe(false);
    expect(RunnerRecord.safeParse({ ...sandbox, state: "sleeping" }).success).toBe(false);
  });

  it("round-trips the lifecycle events", () => {
    const at = { seq: 1, sessionId: null, ts };
    roundTrip(EventEnvelope, { ...at, type: "runner.registered", payload: { runner: sandbox } });
    roundTrip(EventEnvelope, { ...at, type: "runner.deleted", payload: { id: "rn-1" } });
    for (const type of ["runner.disconnected", "runner.draining"] as const) {
      roundTrip(EventEnvelope, {
        ...at,
        type,
        payload: { id: "rn-1", runnerId: "r", reason: "x" },
      });
    }
    roundTrip(EventEnvelope, {
      ...at,
      type: "runner.connected",
      payload: { id: "rn-1", runnerId: "r", version: CODEDEN_VERSION, protocolVersion: 1 },
    });
  });

  it("still reads runner events stored before records existed (no id: the home runner)", () => {
    const old = EventEnvelope.parse({
      seq: 1,
      sessionId: null,
      ts,
      type: "runner.connected",
      payload: { runnerId: "r", version: "0.1.0", protocolVersion: 1 },
    });
    expect(old.type === "runner.connected" && old.payload.id).toBeUndefined();
  });

  it("lists runners in the snapshot and the runner message, and reads older snapshots", () => {
    const runner = {
      state: "connected",
      runnerId: "r-home",
      version: CODEDEN_VERSION,
      providers: [],
      lastError: null,
    } as const;
    const snapshot = {
      seq: 0,
      serverVersion: CODEDEN_VERSION,
      generatedAt: ts,
      settings: defaultSettings(),
      projects: [],
      sessions: [],
      inbox: [],
      automations: [],
      runner,
    };
    expect(Snapshot.parse(snapshot).runners).toEqual([]);
    expect(roundTrip(Snapshot, { ...snapshot, runners: [home, sandbox] }).runners).toHaveLength(2);
    roundTrip(ServerToClientMessage, { type: "runner", runner });
    roundTrip(ServerToClientMessage, { type: "runner", runner, runners: [home] });
  });
});
