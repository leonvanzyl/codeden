import { type AgentEvent, agentEventToNewEvent } from "@codeden/contracts";
import { OpenCodeEventMapper } from "@codeden/providers";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #218: with Codex at its limit, the reviewer fell back to OpenCode on an `openai/*`
// model whose OpenAI login had expired. Its turn failed with `Request failed: 401`, which
// counted as an ordinary reviewer failure, so the next reviewer started on OpenCode again.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, openPr } = factorySteps(() => env);

const HOUR = 60 * 60_000;

/** A feature under review: Claude built it, Codex is at its weekly limit. */
async function underReview(): Promise<string> {
  env = createFactoryEnv({ providers: ["claude", "codex", "opencode"] });
  enable("software_factory");
  const created = backlogItem();
  await tick();
  env.rateLimits.push({
    provider: "codex",
    status: "limited",
    resetsAt: new Date(env.now().getTime() + 30 * HOUR).toISOString(),
    observedAt: env.now().toISOString(),
  });
  await openPr(created.id);
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return created.id;
}

/** The OpenCode session's turn fails the way OpenCode reports it, through the real mapper. */
function openCodeTurnFails(sessionId: string, message: string): void {
  const events: AgentEvent[] = [];
  const mapper = new OpenCodeEventMapper({
    sessionId,
    emit: (e) => events.push(e),
    tools: { cwd: "/repo", mcpServers: [] },
  });
  mapper.rootSession = "ses_review";
  events.push({ type: "thread.started", thread: { id: mapper.rootThreadId } } as AgentEvent);
  mapper.beginTurn("turn-1");
  mapper.handle({ type: "session.execution.started", data: { sessionID: "ses_review" } });
  mapper.handle({
    type: "session.execution.failed",
    data: { sessionID: "ses_review", error: { type: "unknown", message } },
  });
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

describe("factory reviewer on a provider whose sign-in expired", () => {
  it("restarts the review on another provider after OpenCode's `Request failed: 401`", async () => {
    const id = await underReview();
    const first = item(id).reviewerSessionId as string;
    expect(item(id).reviewerProvider).toBe("opencode");

    openCodeTurnFails(first, "Request failed: 401");
    await tick();
    const note = item(id).note;
    await tick();
    const current = item(id);
    expect(current.reviewerSessionId).not.toBe(first);
    // A provider failure, not a dead reviewer: OpenCode is skipped, the review moves to Claude,
    // and neither a reviewer restart nor a revise round is used.
    expect({
      note,
      stage: current.stage,
      reviewerProvider: current.reviewerProvider,
      skipsOpenCode: Boolean(current.nudges.reviewer_skip_opencode),
      reviewerFailed: current.nudges.reviewer_failed_1 ?? null,
      attempts: current.attempts,
    }).toEqual({
      note: expect.stringMatching(/^The reviewer stopped: opencode is not signed in/),
      stage: "verifying",
      reviewerProvider: "claude",
      skipsOpenCode: true,
      reviewerFailed: null,
      attempts: 0,
    });
  });

  it("keeps reviews off OpenCode until its backoff ends", async () => {
    const id = await underReview();
    openCodeTurnFails(item(id).reviewerSessionId as string, "Request failed: 401");
    await tick();
    await tick();
    expect(item(id).reviewerProvider).toBe("claude");

    // The Claude reviewer dies for another reason: its replacement still avoids OpenCode.
    await env.setStatus(item(id).reviewerSessionId as string, "failed");
    await tick();
    await tick();
    expect(item(id).nudges.reviewer_failed_1).toBeDefined();
    expect(item(id).reviewerProvider).toBe("claude");

    // Once the backoff is over, OpenCode is tried again.
    later(31 * 60_000);
    await env.setStatus(item(id).reviewerSessionId as string, "failed");
    await tick();
    await tick();
    expect(item(id).nudges.reviewer_failed_2).toBeDefined();
    expect(item(id).reviewerProvider).toBe("opencode");
  });
});
