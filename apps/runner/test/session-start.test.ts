import { tmpdir } from "node:os";
import type { SessionOptions } from "@codeden/contracts";
import { FakeProvider, type ProviderAdapter, ProviderRegistry } from "@codeden/providers";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHost } from "../src/session-host";

const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

let host: SessionHost | undefined;
afterEach(async () => {
  await host?.closeAll();
  host = undefined;
});

/** The Fake provider, whose opens wait until `release` (a real CLI takes seconds to start). */
function slowFake() {
  const inner = new FakeProvider();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { opens: 0 };
  const adapter: ProviderAdapter = {
    id: inner.id,
    displayName: inner.displayName,
    detect: () => inner.detect(),
    capabilities: () => inner.capabilities(),
    models: () => inner.models(),
    openSession: async (opts) => {
      state.opens += 1;
      await gate;
      return inner.openSession(opts);
    },
  };
  return { adapter, state, release: () => release() };
}

describe("session.start", () => {
  it("refuses a second start while the first is still opening the session (#208)", async () => {
    const fake = slowFake();
    const running = new SessionHost(new ProviderRegistry([fake.adapter]), () => {});
    host = running;
    const start = () =>
      running.start({
        name: "session.start",
        sessionId: "s1",
        providerId: "fake",
        options,
        checkpoints: false,
      });
    const first = start();
    // A second open would run the conversation twice, one of them with a retired MCP token.
    await expect(start()).rejects.toMatchObject({ code: "session_exists" });
    fake.release();
    await first;
    expect(fake.state.opens).toBe(1);
    expect(running.list().map((s) => s.sessionId)).toEqual(["s1"]);
    await expect(start()).rejects.toMatchObject({ code: "session_exists" });
  });
});
