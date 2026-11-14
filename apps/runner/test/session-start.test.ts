import { tmpdir } from "node:os";
import type { RunnerEvent, SessionOptions } from "@codeden/contracts";
import {
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  ProviderSessionError,
} from "@codeden/providers";
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

  it("reports how the provider classified a refused open (#269)", async () => {
    const inner = new FakeProvider();
    const message = "Gemini CLI 0.36.0 is too old (needs 0.68.0+).";
    const adapter: ProviderAdapter = {
      id: inner.id,
      displayName: inner.displayName,
      detect: () => inner.detect(),
      capabilities: () => inner.capabilities(),
      models: () => inner.models(),
      openSession: async () => {
        throw new ProviderSessionError("version_unsupported", message, "setup");
      },
    };
    const events: RunnerEvent[] = [];
    host = new SessionHost(new ProviderRegistry([adapter]), (e) => events.push(e));
    await expect(
      host.start({ name: "session.start", sessionId: "s1", providerId: "fake", options }),
    ).rejects.toMatchObject({ code: "open_failed" });
    expect(events.at(-1)).toEqual({
      kind: "session.process",
      sessionId: "s1",
      state: "crashed",
      error: { code: "open_failed", message, kind: "setup" },
    });
  });
});
