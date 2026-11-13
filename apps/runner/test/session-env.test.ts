import { tmpdir } from "node:os";
import type { SessionOptions } from "@codeden/contracts";
import { FakeProvider, ProviderRegistry, type ProviderSession } from "@codeden/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessionOptions } from "../src/session-env";
import { SessionHost } from "../src/session-host";

/** The Fake provider, remembering the options each session was opened with. */
class RecordingProvider extends FakeProvider {
  opened: SessionOptions[] = [];

  override async openSession(opts: SessionOptions): Promise<ProviderSession> {
    this.opened.push(opts);
    return super.openSession(opts);
  }
}

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
  vi.unstubAllEnvs();
});

async function openedEnv(start: SessionOptions): Promise<Record<string, string> | undefined> {
  const provider = new RecordingProvider();
  host = new SessionHost(new ProviderRegistry([provider]), () => {});
  await host.start({
    name: "session.start",
    sessionId: start.sessionId,
    providerId: "fake",
    options: start,
    checkpoints: false,
  });
  return provider.opened[0]?.env;
}

describe("agent session environment", () => {
  // #194: agent shells have no TTY, so a prompt such as pnpm's "The modules directory will be
  // removed and reinstalled from scratch. Proceed?" waits forever. `CI=true` is the switch pnpm
  // (and most other tools) read to never ask.
  it("runs every agent session non-interactively (CI=true)", async () => {
    vi.stubEnv("CI", undefined);
    expect(await openedEnv(options)).toMatchObject({ CI: "true" });
  });

  it("keeps the session's own variables, and they win", async () => {
    vi.stubEnv("CI", undefined);
    const env = await openedEnv({ ...options, env: { CI: "1", EXTRA: "kept" } });
    expect(env).toEqual({ CI: "1", EXTRA: "kept" });
  });

  it("keeps a CI the user's environment sets, so CI=false opts out", () => {
    expect(agentSessionOptions(options, { CI: "false" }).env).toEqual({ CI: "false" });
    expect(agentSessionOptions(options, { CI: "" }).env).toEqual({ CI: "true" });
    expect(agentSessionOptions(options, {})).toEqual({ ...options, env: { CI: "true" } });
  });
});
