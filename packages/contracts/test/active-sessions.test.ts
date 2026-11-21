import { describe, expect, it } from "vitest";
import { ACTIVE_SESSION_STATUSES, isActiveSession, SessionStatus } from "../src";

describe("ACTIVE_SESSION_STATUSES", () => {
  it("is the not-started, running and waiting statuses, each a valid SessionStatus", () => {
    expect(ACTIVE_SESSION_STATUSES).toEqual([
      "created",
      "queued",
      "starting",
      "running",
      "waiting",
    ]);
    for (const status of ACTIVE_SESSION_STATUSES) {
      expect(SessionStatus.parse(status)).toBe(status);
    }
  });

  it("isActiveSession is true for exactly those statuses", () => {
    const active = SessionStatus.options.filter((status) => isActiveSession({ status }));
    expect(active).toEqual([...ACTIVE_SESSION_STATUSES]);
    for (const status of ["idle", "interrupted", "completed", "failed", "stopped"] as const) {
      expect(isActiveSession({ status })).toBe(false);
    }
  });
});
