import type { Item, UserInputInit } from "@codeden/contracts";
import { cmd, read, search } from "./fixtures/item-builders";
import type { MockWorld } from "./world";

type Step = { wait: number; run: () => void };

/** A cancellable sequence of timed steps. */
export class Script {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  constructor(
    private steps: Step[],
    private onDone?: () => void,
  ) {}
  start(): this {
    this.next(0);
    return this;
  }
  private next(i: number) {
    if (this.cancelled) return;
    const step = this.steps[i];
    if (!step) {
      this.onDone?.();
      return;
    }
    this.timer = setTimeout(() => {
      if (this.cancelled) return;
      step.run();
      this.next(i + 1);
    }, step.wait);
  }
  cancel() {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

let counter = 0;
export const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Split text into small chunks that look like token streaming. */
export function chunks(text: string, size = 14): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Steps that stream `text` into an already-started item. */
export function streamSteps(
  world: MockWorld,
  ids: { sessionId: string; threadId: string; turnId: string; itemId: string },
  text: string,
  type: "text" | "tool_output" = "text",
  every = 45,
): Step[] {
  const parts = type === "text" ? chunks(text) : text.split(/(?<=\n)/);
  return parts.map((part) => ({
    wait: type === "text" ? every : 380,
    run: () =>
      world.emitAgent(ids.sessionId, {
        type: "item.delta",
        threadId: ids.threadId,
        turnId: ids.turnId,
        itemId: ids.itemId,
        delta:
          type === "text"
            ? { type: "text", text: part }
            : { type: "tool_output", text: part, stream: "stdout" },
      }),
  }));
}

function replyFor(prompt: string): string {
  const topic = prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  return `Done. I looked into **${topic}${prompt.length > 80 ? "…" : ""}** and made the change.

- Read the relevant modules and their tests first.
- Kept the change small and covered it with a focused test.
- \`pnpm test\` passes locally.

\`\`\`ts
export function isStale(id: number, latest: number): boolean {
  return id !== latest;
}
\`\`\`

Let me know if you'd like a PR opened for this.`;
}

/** A complete generic agent turn in response to a user message. */
export function scriptedTurn(
  world: MockWorld,
  sessionId: string,
  input: UserInputInit,
  onDone: () => void,
): Script {
  const threadId = world.transcript(sessionId).rootThreadId ?? `t-${sessionId}`;
  const turnId = uid("turn");
  const ids = { sessionId, threadId, turnId };
  const start = (item: Item) => world.emitAgent(sessionId, { type: "item.started", ...ids, item });
  const done = (item: Item) => world.emitAgent(sessionId, { type: "item.completed", ...ids, item });
  const reasoningId = uid("r");
  const commandId = uid("c");
  const replyId = uid("a");
  const output =
    "\n ✓ src/lib/stale.test.ts (3 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
  const reply = replyFor(input.text);

  return new Script(
    [
      {
        wait: 0,
        run: () => {
          world.updateSession(sessionId, { status: "running" });
          world.emitAgent(sessionId, { type: "turn.started", ...ids });
          done({
            id: uid("u"),
            kind: "user_message",
            status: "completed",
            input: {
              text: input.text,
              attachments: input.attachments ?? [],
              ...(input.from ? { from: input.from } : {}),
            },
          });
        },
      },
      {
        wait: 400,
        run: () =>
          start({
            id: reasoningId,
            kind: "reasoning",
            status: "in_progress",
            text: "",
            summary: "Planning the change",
          }),
      },
      {
        wait: 900,
        run: () =>
          done({
            id: reasoningId,
            kind: "reasoning",
            status: "completed",
            text: "Read the code, change it minimally, then test.",
            summary: "Planning the change",
          }),
      },
      { wait: 500, run: () => done(read(uid("t"), "src/lib/stale.ts")) },
      { wait: 500, run: () => done(search(uid("t"), "isStale", 2, "src")) },
      { wait: 500, run: () => start({ ...cmd(commandId, "pnpm vitest run src/lib", "", null) }) },
      ...streamSteps(world, { ...ids, itemId: commandId }, output, "tool_output"),
      { wait: 300, run: () => done(cmd(commandId, "pnpm vitest run src/lib", output, 0, 2100)) },
      {
        wait: 300,
        run: () =>
          start({ id: replyId, kind: "assistant_message", status: "in_progress", text: "" }),
      },
      ...streamSteps(world, { ...ids, itemId: replyId }, reply),
      {
        wait: 200,
        run: () => {
          done({ id: replyId, kind: "assistant_message", status: "completed", text: reply });
          done({
            id: uid("f"),
            kind: "followups",
            status: "completed",
            source: "agent",
            suggestions: [
              {
                label: "Open a PR",
                prompt: "Push the branch and open a pull request with the test output as evidence.",
              },
              { label: "Add more tests", prompt: "Add edge-case tests for the change." },
              { label: "Explain the diff", prompt: "Walk me through the diff file by file." },
            ],
          });
          world.emitAgent(sessionId, {
            type: "turn.completed",
            ...ids,
            forkPoint: ids.turnId,
            stopReason: "end_turn",
          });
          world.updateSession(sessionId, { status: "idle" });
        },
      },
    ],
    onDone,
  );
}
