import { tmpdir } from "node:os";
import type { SessionOptions } from "@codeden/contracts";
import {
  FakeProvider,
  type FakeSession,
  type ProviderAdapter,
  ProviderRegistry,
  type ProviderSession,
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

/** The Fake provider under `id`, recording its sessions and without the `missing` methods. */
function fakeAs(
  id: string,
  sessions: ProviderSession[],
  missing: Array<"configure" | "setAutonomy" | "setPlanMode"> = [],
): ProviderAdapter {
  const fake = new FakeProvider();
  return {
    id,
    displayName: id,
    detect: () => fake.detect(),
    capabilities: () => fake.capabilities(),
    models: () => fake.models(),
    openSession: async (opts) => {
      const session = await fake.openSession(opts);
      for (const name of missing) Object.defineProperty(session, name, { value: undefined });
      sessions.push(session);
      return session;
    },
  };
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.closeAll()));
});

async function start(adapter: ProviderAdapter): Promise<SessionHost> {
  const host = new SessionHost(new ProviderRegistry([adapter]), () => {});
  hosts.push(host);
  await host.start({
    name: "session.start",
    sessionId: "s1",
    providerId: adapter.id,
    options,
    checkpoints: false,
  });
  return host;
}

describe("session.configure", () => {
  it("hands autonomy changes to the provider session, alongside model and effort", async () => {
    const sessions: ProviderSession[] = [];
    const host = await start(fakeAs("fake", sessions));
    const fake = () => sessions[0] as FakeSession;
    await host.configure({ name: "session.configure", sessionId: "s1", autonomy: "full" });
    expect(fake().autonomy).toBe("full");
    await host.configure({
      name: "session.configure",
      sessionId: "s1",
      model: "fake-2",
      autonomy: "supervised",
    });
    expect(fake().autonomy).toBe("supervised");
    expect(fake().lastConfig).toEqual({ model: "fake-2" });
  });

  it("refuses what the provider cannot change live, before applying anything", async () => {
    const sessions: ProviderSession[] = [];
    const host = await start(fakeAs("limited", sessions, ["setAutonomy"]));
    const fake = () => sessions[0] as FakeSession;
    await expect(
      host.configure({ name: "session.configure", sessionId: "s1", autonomy: "full" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      host.configure({ name: "session.configure", sessionId: "s1", model: "x", autonomy: "full" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fake().lastConfig).toEqual({});
    await host.configure({ name: "session.configure", sessionId: "s1", model: "x" });
    expect(fake().lastConfig).toEqual({ model: "x" });
    await expect(
      host.configure({ name: "session.configure", sessionId: "nope", autonomy: "full" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("turns plan mode on and off, or refuses it on a provider without plan mode", async () => {
    const sessions: ProviderSession[] = [];
    const host = await start(fakeAs("fake", sessions));
    const fake = () => sessions[0] as FakeSession;
    expect(fake().planMode).toBe(false);
    await host.configure({ name: "session.configure", sessionId: "s1", planMode: true });
    expect(fake().planMode).toBe(true);
    await host.configure({ name: "session.configure", sessionId: "s1", planMode: false });
    expect(fake().planMode).toBe(false);

    const others: ProviderSession[] = [];
    const limited = await start(fakeAs("limited", others, ["setPlanMode"]));
    await expect(
      limited.configure({
        name: "session.configure",
        sessionId: "s1",
        autonomy: "full",
        planMode: true,
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect((others[0] as FakeSession).autonomy).toBe("auto");
  });

  it("passes on a provider's refusal, so the server keeps the change for a retry", async () => {
    const sessions: ProviderSession[] = [];
    const host = await start(fakeAs("fake", sessions));
    Object.assign(sessions[0] as FakeSession, {
      setPlanMode: async () => {
        throw new Error("Cannot set permission mode to plan");
      },
    });
    await expect(
      host.configure({ name: "session.configure", sessionId: "s1", planMode: true }),
    ).rejects.toThrow(/permission mode/);
  });
});
