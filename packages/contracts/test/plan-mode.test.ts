import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  Item,
  RunnerCommand,
  Session,
  SessionOptions,
  StartSessionRequest,
  UpdateSessionRequest,
} from "../src";
import { sampleSession } from "./fixtures";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));

describe("plan mode contracts", () => {
  it("starts a session in plan mode", () => {
    const req = roundTrip(StartSessionRequest, { projectId: "p1", planMode: true });
    expect(req.planMode).toBe(true);
    expect(StartSessionRequest.parse({ projectId: "p1" }).planMode).toBeUndefined();
    expect(() => StartSessionRequest.parse({ projectId: "p1", planMode: "yes" })).toThrow();
  });

  it("turns plan mode on and off with PATCH /api/sessions/:id", () => {
    expect(roundTrip(UpdateSessionRequest, { planMode: false })).toEqual({ planMode: false });
    expect(roundTrip(UpdateSessionRequest, { planMode: true, autonomy: "full" })).toEqual({
      planMode: true,
      autonomy: "full",
    });
    expect(() => UpdateSessionRequest.parse({})).toThrow();
  });

  it("carries plan mode on the session, absent meaning off", () => {
    expect(roundTrip(Session, { ...sampleSession, planMode: true }).planMode).toBe(true);
    expect(roundTrip(Session, sampleSession).planMode).toBeUndefined();
    expect(
      SessionOptions.parse({ sessionId: "s1", role: "agent", cwd: "/r", autonomy: "auto" }),
    ).toMatchObject({ planMode: false });
  });

  it("sends plan mode to the runner with session.configure", () => {
    const command = { name: "session.configure" as const, sessionId: "s1", planMode: false };
    expect(roundTrip(RunnerCommand, command)).toEqual(command);
    expect(() => RunnerCommand.parse({ ...command, planMode: "off" })).toThrow();
  });

  it("lets a provider report that the agent left plan mode", () => {
    const event = { type: "session.updated" as const, planMode: false };
    expect(roundTrip(AgentEvent, event)).toEqual(event);
  });

  it("marks the plan approval with the plan action", () => {
    const item = {
      id: "approval-1",
      kind: "approval_request" as const,
      status: "in_progress" as const,
      requestId: "r1",
      action: "plan" as const,
      title: "Approve the plan and start implementing",
      options: ["allow_once", "deny"],
    };
    expect(roundTrip(Item, item)).toEqual(item);
  });
});
