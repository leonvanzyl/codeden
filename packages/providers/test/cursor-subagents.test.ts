import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Item, ItemOf } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { validateEventStream } from "../src/replay/validate";
import {
  chunk,
  completedOf,
  fakeAcp,
  isTurnEnd,
  type Request,
  type Step,
} from "./support/fake-acp";

const acp = fakeAcp();
const { logged, open } = acp;

const ROOT = "s1:thread-root";
const subagentScript = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "fake-acp", "subagent.json"), "utf8"),
) as Step[];

const spawned = (id: string, name: string, task = `Do ${name}`): Step => ({
  update: { sessionUpdate: "subagent_spawned", subagentSessionId: id, name, task },
});
const state = (id: string, value: string, extra: Record<string, unknown> = {}): Step => ({
  update: { sessionUpdate: "subagent_state_update", subagentSessionId: id, state: value, ...extra },
});
const toolCall = (toolCallId: string, status: string, text?: string): Step => ({
  update: {
    sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
    toolCallId,
    title: "Task",
    kind: "other",
    status,
    ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
  },
});

/** The items a thread started or completed, in order. */
const inThread = (events: AgentEvent[], threadId: string): Item[] =>
  events.flatMap((e) =>
    (e.type === "item.started" || e.type === "item.completed") && e.threadId === threadId
      ? [e.item]
      : [],
  );
const childThreads = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "thread.started" && e.thread.parentThreadId ? [e.thread] : []));
const cards = (events: AgentEvent[]) => completedOf(events, "subagent") as ItemOf<"subagent">[];

describe("Cursor subagents as child threads", () => {
  it("runs the subagent script: a card, its child thread, and the child's approval", async () => {
    const { reader, adapter } = await open(subagentScript);
    const asked: { item: Request; threadId: string }[] = [];
    reader.answer = (item) => {
      const started = reader.all.at(-1);
      asked.push({ item, threadId: started && "threadId" in started ? started.threadId : "" });
      return { kind: "approval", decision: "allow_once" };
    };
    const events = await reader.turn("Find the auth code");

    // Opted in at `initialize`, in ACP's place and in Cursor's.
    expect(logged("initialize")[0]?.params.clientCapabilities).toMatchObject({
      subagents: {},
      _meta: { subagents: {} },
    });
    expect(adapter.capabilities().subagents).toBe(true);

    const [thread] = childThreads(events);
    const [card] = cards(events);
    expect(thread).toMatchObject({
      parentThreadId: ROOT,
      parentItemId: card?.id,
      title: "Explore auth",
      agentType: "explore",
    });
    const started = events.find((e) => e.type === "item.started" && e.item.kind === "subagent");
    expect(started).toMatchObject({
      threadId: ROOT,
      item: {
        status: "in_progress",
        description: "Explore auth",
        prompt: "Find where auth is handled",
        childThreadId: thread?.id,
      },
    });

    // The child's steps are in its own thread, never in the root's.
    const child = inThread(events, thread?.id ?? "");
    expect([...new Set(child.map((i) => i.kind))]).toEqual([
      "user_message",
      "tool_call",
      "approval_request",
      "assistant_message",
    ]);
    expect(
      inThread(events, ROOT).some((i) => i.kind === "tool_call" && i.toolKind === "command"),
    ).toBe(false);

    // Its approval was asked in the child thread and answered through the session.
    expect(asked).toMatchObject([
      {
        threadId: thread?.id,
        item: { action: "git_destructive", command: "git push --force origin main" },
      },
    ]);
    expect(logged("answer:session/request_permission")[0]?.params.outcome).toEqual({
      outcome: "selected",
      optionId: "allow-once",
    });

    // The card closes with the child's answer and what it did; `cursor/task` adds no second card.
    expect(cards(events)).toHaveLength(1);
    expect(card).toMatchObject({
      status: "completed",
      agentType: "explore",
      summary: "Auth lives in src/auth.ts.",
      stats: { toolUses: 1 },
    });
    expect(card?.stats?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", threadId: thread?.id }),
    );

    // The child's mode, commands and usage are its own.
    expect(events.some((e) => e.type === "session.updated" && "commands" in e)).toBe(false);
    expect(events.some((e) => e.type === "usage.updated" && e.threadId !== ROOT)).toBe(false);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("keeps plan mode on when a child session changes its own mode", async () => {
    const { reader } = await open(
      [
        spawned("sub-p", "Research"),
        {
          session: "sub-p",
          update: { sessionUpdate: "current_mode_update", currentModeId: "agent" },
        },
        chunk("Found three options.", "sub-p"),
        state("sub-p", "completed"),
      ],
      { planMode: true },
    );
    await reader.turn("Plan it");
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan"]);
    expect(reader.all.some((e) => e.type === "session.updated" && e.planMode === false)).toBe(
      false,
    );
    expect(cards(reader.all)[0]).toMatchObject({ summary: "Found three options." });
  });

  it("fails a failed child's card, and closes running ones when the turn ends", async () => {
    const { reader } = await open([
      spawned("sub-a", "First"),
      spawned("sub-b", "Second"),
      state("sub-a", "failed", { message: "Model unavailable" }),
      chunk("Done here."),
    ]);
    const events = await reader.turn("Go");
    const byName = Object.fromEntries(cards(events).map((c) => [c.description, c]));
    expect(byName.First).toMatchObject({ status: "failed", summary: "Model unavailable" });
    expect(byName.Second).toMatchObject({ status: "completed" });
    const [first, second] = childThreads(events);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.failed", threadId: first?.id }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", threadId: second?.id }),
    );
    expect(validateEventStream(reader.all)).toEqual([]);

    // Stopping the session's turn cancels a subagent that is still running.
    const stopped = await open([spawned("sub-c", "Long"), { hang: true }]);
    await stopped.session.send({ text: "Go", attachments: [] });
    await stopped.reader.until((e) => e.type === "item.started" && e.item.kind === "subagent");
    await stopped.session.interrupt();
    await stopped.reader.until((e) => isTurnEnd(e) && e.threadId === ROOT);
    expect(cards(stopped.reader.all)[0]).toMatchObject({ status: "cancelled" });
    expect(stopped.reader.all).toContainEqual(
      expect.objectContaining({
        type: "turn.interrupted",
        threadId: childThreads(stopped.reader.all)[0]?.id,
      }),
    );
    expect(validateEventStream(stopped.reader.all)).toEqual([]);
  });

  it("shows `cursor/task` as a card with the task's thread on CLIs without child sessions", async () => {
    const { reader, adapter } = await open(
      [
        // Reported once its Task call has finished: the card is done at once.
        toolCall("task-1", "in_progress"),
        toolCall("task-1", "completed", "Found it in src/auth.ts."),
        {
          request: "cursor/task",
          params: {
            toolCallId: "task-1",
            description: "Review auth",
            prompt: "Review the auth module",
            subagentType: { custom: "reviewer" },
            agentId: "agent-7",
            durationMs: 1500,
          },
        },
        // Reported while its Task call still runs: the card closes when the call does.
        toolCall("task-2", "in_progress"),
        {
          notify: "cursor/task",
          params: {
            toolCallId: "task-2",
            description: "Explore",
            prompt: "Look around",
            subagentType: "unspecified",
          },
        },
        toolCall("task-2", "completed", "Nothing else."),
      ],
      { env: { FAKE_ACP_SUBAGENTS: "0" } },
    );
    const events = await reader.turn("Review");
    expect(adapter.capabilities().subagents).toBe(false);
    expect(logged("answer:cursor/task")[0]?.params).toEqual({
      outcome: { outcome: "completed", agentId: "agent-7", durationMs: 1500 },
    });

    const [review, explore] = cards(events);
    expect(review).toMatchObject({
      status: "completed",
      description: "Review auth",
      prompt: "Review the auth module",
      agentType: "reviewer",
      summary: "Found it in src/auth.ts.",
      stats: { durationMs: 1500 },
    });
    expect(review?.stats?.toolUses).toBeUndefined();
    const reviewThread = inThread(events, review?.childThreadId ?? "");
    expect(reviewThread).toMatchObject([
      { kind: "user_message", input: { text: "Review the auth module" } },
      { kind: "assistant_message", text: "Found it in src/auth.ts." },
    ]);

    expect(explore).toMatchObject({ status: "completed", summary: "Nothing else." });
    expect(explore?.agentType).toBeUndefined();
    const exploreDone = events.findIndex(
      (e) => e.type === "item.completed" && e.item.id === explore?.id,
    );
    const task2Done = events.findIndex(
      (e) =>
        e.type === "item.completed" && e.item.kind === "tool_call" && e.item.id.endsWith(":task-2"),
    );
    expect(exploreDone).toBeGreaterThan(task2Done);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("shows `cursor/generate_image` as a tool call with the image Cursor wrote", async () => {
    const image = join(acp.dir, "fox.png");
    writeFileSync(image, "png bytes");
    const { reader } = await open([
      {
        request: "cursor/generate_image",
        params: { toolCallId: "img-1", description: "A red fox", filePath: "fox.png" },
      },
      // Cursor's own call for the image: the image goes on it.
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "img-2",
          title: "Generate image",
          kind: "other",
          status: "in_progress",
        },
      },
      {
        notify: "cursor/generate_image",
        params: { toolCallId: "img-2", description: "A blue fox", filePath: image },
      },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "img-2", status: "completed" } },
      // A file that isn't there: refused, so Cursor falls back on its own.
      {
        request: "cursor/generate_image",
        params: { toolCallId: "img-3", description: "Gone", filePath: join(acp.dir, "gone.png") },
      },
    ]);
    const events = await reader.turn("Draw a fox");
    const answers = logged("answer:cursor/generate_image").map((m) => m.params);
    expect(answers[0]).toEqual({ outcome: { outcome: "generated", filePath: image } });
    expect(answers[1]).toMatchObject({ error: { code: -32601 } });

    const withImages = (completedOf(events, "tool_call") as ItemOf<"tool_call">[]).filter(
      (t) => t.generatedImages,
    );
    expect(withImages).toMatchObject([
      {
        toolName: "generate_image",
        title: "Generate image",
        status: "completed",
        generatedImages: [{ path: image, caption: "A red fox" }],
      },
      { title: "Generate image", generatedImages: [{ path: image, caption: "A blue fox" }] },
    ]);
    expect(withImages[1]?.id.endsWith(":img-2")).toBe(true);
    expect(validateEventStream(reader.all)).toEqual([]);
  });
});
