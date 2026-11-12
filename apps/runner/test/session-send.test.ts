import { tmpdir } from "node:os";
import type { SessionOptions } from "@codeden/contracts";
import { FakeProvider, ProviderRegistry } from "@codeden/providers";
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

describe("session.send", () => {
  it("answers `turn_running` while a turn runs, so the server queues the message", async () => {
    host = new SessionHost(new ProviderRegistry([new FakeProvider()]), () => {});
    await host.start({
      name: "session.start",
      sessionId: "s1",
      providerId: "fake",
      options,
      checkpoints: false,
    });
    const send = (text: string) =>
      (host as SessionHost).send({
        name: "session.send",
        sessionId: "s1",
        input: { text, attachments: [] },
      });
    // The Fake provider's turn waits on an approval, so it keeps running.
    await send("hold on [approval]");
    await expect(send("a second message")).rejects.toMatchObject({
      code: "turn_running",
      message: "A turn is already running",
    });
  });
});
