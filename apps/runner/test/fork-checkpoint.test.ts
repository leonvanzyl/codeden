import type { RunnerCommandResult, RunnerEvent } from "@codeden/contracts";
import { FakeProvider, ProviderRegistry } from "@codeden/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCommand, type RunnerCore } from "../src/commands";
import { SessionHost } from "../src/session-host";
import { makeRepo, removeDir } from "./helpers";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Listed = RunnerCommandResult<"checkpoint.list">;

/**
 * A fork right after a turn ends must get that turn's checkpoint (§9). The runner reports the
 * turn's end before the checkpoint is written, so the server asks for the list `settled`. Here
 * the list is requested at the worst moment: inside the very `turn.completed` event.
 */
describe("checkpoint.list settled", () => {
  it("includes the checkpoint of a turn that has just ended", async () => {
    const repo = makeRepo();
    cleanup.push(() => removeDir(repo));
    const events: RunnerEvent[] = [];
    let listed: Promise<Listed> | undefined;
    const host: SessionHost = new SessionHost(new ProviderRegistry([new FakeProvider()]), (e) => {
      events.push(e);
      const ended =
        e.kind === "agent" &&
        e.event.type === "turn.completed" &&
        e.event.threadId === "s1:thread-root";
      if (ended && !listed) {
        const core = { host } as unknown as RunnerCore;
        const command = { name: "checkpoint.list" as const, cwd: repo, sessionId: "s1" };
        listed = executeCommand(core, { ...command, settled: true }) as Promise<Listed>;
      }
    });
    cleanup.push(() => host.closeAll());

    await host.start({
      name: "session.start",
      sessionId: "s1",
      providerId: "fake",
      options: {
        sessionId: "s1",
        role: "agent",
        cwd: repo,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      },
      input: { text: "change something", attachments: [] },
    });
    await vi.waitFor(() => expect(listed).toBeDefined());
    const { checkpoints } = (await listed) as Listed;
    // The baseline and the turn that just ended.
    expect(checkpoints.map((c) => c.index)).toEqual([0, 1]);

    // The server still hears the turn end before its checkpoint.
    const turnEnd = events.findIndex(
      (e) => e.kind === "agent" && e.event.type === "turn.completed",
    );
    const checkpoint = events.findIndex((e) => e.kind === "checkpoint.created" && e.index === 1);
    expect(turnEnd).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeGreaterThan(turnEnd);
  });

  it("answers at once for a session the runner doesn't host", async () => {
    const host = new SessionHost(new ProviderRegistry([]), () => {});
    await expect(host.settled("nobody")).resolves.toBeUndefined();
  });
});
