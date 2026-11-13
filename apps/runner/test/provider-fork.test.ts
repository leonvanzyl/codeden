import {
  FakeProvider,
  FORK_POINT_MISSING,
  ProviderRegistry,
  ProviderSessionError,
} from "@codeden/providers";
import { describe, expect, it } from "vitest";
import { executeCommand, type RunnerCore } from "../src/commands";

/** A Fake provider whose copies fail with `failure` when it is set. */
class FailingFork extends FakeProvider {
  failure: Error | undefined;
  override async forkConversation(token: string, opts?: { cwd: string; upTo?: string }) {
    if (this.failure) throw this.failure;
    return super.forkConversation(token, opts);
  }
}

function fork(provider: FailingFork, upTo?: string) {
  const core = { registry: new ProviderRegistry([provider]) } as unknown as RunnerCore;
  return executeCommand(core, {
    name: "provider.fork",
    providerId: "fake",
    resumeToken: "fake-s1",
    cwd: ".",
    ...(upTo ? { upTo } : {}),
  });
}

describe("provider.fork", () => {
  it("passes the fork point to the provider", async () => {
    await expect(fork(new FailingFork(), "turn-2")).resolves.toEqual({
      resumeToken: "fake-s1:fork-1@turn-2",
    });
  });

  it("keeps a missing fork point apart from other failures", async () => {
    const provider = new FailingFork();
    provider.failure = new ProviderSessionError(FORK_POINT_MISSING, "no longer holds that turn");
    await expect(fork(provider, "turn-2")).rejects.toMatchObject({
      code: "fork_point_missing",
      message: "no longer holds that turn",
    });
    provider.failure = new Error("codex app-server exited");
    await expect(fork(provider, "turn-2")).rejects.toMatchObject({ code: "fork_failed" });
  });
});
