import { readFileSync, rmSync } from "node:fs";
import { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { CODEX_IMAGE_DIR } from "../src/codex/image-result";
import { CodexEventMapper } from "../src/codex/mapper";
import type { ServerNotification } from "../src/codex/protocol";

const T = "thread-x";
const TURN = "turn-1";

function setup() {
  const events: AgentEvent[] = [];
  const mapper = new CodexEventMapper("s1", (e) => events.push(AgentEvent.parse(e)));
  mapper.codexThreadId = T;
  const feed = (method: string, params: object) =>
    mapper.handle({ method, params: { threadId: T, ...params } } as unknown as ServerNotification);
  return { events, feed };
}

/** A generated image as Codex sends it: ~1.5 MB of base64 in `result`. */
const IMAGE_BASE64 = Buffer.alloc(1_100_000, 7).toString("base64");
const SAVED_PATH = "/home/u/.codex/generated_images/thread-x/ig_1.png";

const imageItem = (overrides: object = {}) => ({
  type: "imageGeneration",
  id: "ig_1",
  status: "completed",
  revisedPrompt: "A red fox in the snow",
  result: IMAGE_BASE64,
  failure: null,
  savedPath: SAVED_PATH,
  ...overrides,
});

describe("Codex built-in image generation", () => {
  it("keeps the base64 image out of the transcript events", () => {
    const { events, feed } = setup();
    feed("turn/started", {
      turn: { id: TURN, items: [], status: "inProgress", error: null },
    });
    feed("item/started", {
      turnId: TURN,
      item: imageItem({ status: "generating", result: "", savedPath: undefined }),
    });
    feed("item/completed", { turnId: TURN, item: imageItem() });

    const completed = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "tool_call",
    );
    expect(completed).toBeDefined();
    const serialized = JSON.stringify(completed);
    // The event goes into the never-pruned event log, the items projection and the UI socket.
    expect(serialized.length, "item.completed event size (chars)").toBeLessThan(16_000);
    expect(serialized.includes(IMAGE_BASE64.slice(0, 1_000)), "event holds the base64 image").toBe(
      false,
    );
    // The image is the file Codex saved; the server stores it as an artifact and shows it.
    expect(completed).toMatchObject({
      item: {
        status: "completed",
        toolName: "image_generation",
        input: { revisedPrompt: "A red fox in the snow", savedPath: SAVED_PATH },
        generatedImages: [{ path: SAVED_PATH, caption: "A red fox in the snow" }],
      },
    });
    const started = events.find((e) => e.type === "item.started" && e.item.kind === "tool_call");
    expect(started).toMatchObject({ item: { status: "in_progress" } });
    expect(started && "item" in started && "generatedImages" in started.item).toBe(false);
  });

  it("marks a failed generation as failed", () => {
    const { events, feed } = setup();
    feed("turn/started", {
      turn: { id: TURN, items: [], status: "inProgress", error: null },
    });
    feed("item/completed", {
      turnId: TURN,
      item: imageItem({
        status: "failed",
        result: "",
        savedPath: undefined,
        failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: 1794465315 },
      }),
    });

    const completed = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "tool_call",
    );
    expect(completed).toMatchObject({
      item: {
        status: "failed",
        error: {
          message: `Codex image generation limit reached (resets ${new Date(1794465315 * 1000).toISOString()})`,
        },
      },
    });
    expect(completed && "item" in completed && "generatedImages" in completed.item).toBe(false);
  });

  it("writes the image itself when Codex saved none, and points at that file", () => {
    // A real PNG header (1x1) followed by ~1 MB, so the base64 is large too.
    const png = Buffer.concat([
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
      Buffer.alloc(1_000_000, 1),
    ]);
    const base64 = png.toString("base64");
    const id = `ig_nosave_${process.pid}`;
    const { events, feed } = setup();
    feed("item/started", {
      turnId: TURN,
      item: imageItem({ id, status: "generating", result: "", savedPath: undefined }),
    });
    feed("item/completed", {
      turnId: TURN,
      item: imageItem({ id, result: base64, savedPath: undefined }),
    });

    const json = JSON.stringify(events);
    expect(json.includes(base64.slice(0, 1_000)), "an event holds the base64 image").toBe(false);
    const completed = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "tool_call",
    );
    const item = completed && "item" in completed ? completed.item : undefined;
    expect(item).toMatchObject({ status: "completed" });
    const file = item?.kind === "tool_call" ? item.generatedImages?.[0]?.path : undefined;
    if (!file) throw new Error("no image file");
    try {
      expect(file.startsWith(CODEX_IMAGE_DIR)).toBe(true);
      expect(file.endsWith(".png")).toBe(true);
      expect(readFileSync(file).equals(png)).toBe(true);
      expect(item).toMatchObject({
        input: { savedPath: file },
        generatedImages: [{ path: file, caption: "A red fox in the snow" }],
      });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("fails a generation whose result is not an image and Codex saved nothing", () => {
    const { events, feed } = setup();
    feed("item/completed", { turnId: TURN, item: imageItem({ savedPath: undefined }) });
    const completed = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "tool_call",
    );
    expect(completed).toMatchObject({
      item: { status: "failed", error: { message: "Codex returned data that is not an image" } },
    });
    expect(completed && "item" in completed && "generatedImages" in completed.item).toBe(false);
  });

  it("marks a generation that finished without an image as failed", () => {
    const { events, feed } = setup();
    feed("item/completed", {
      turnId: TURN,
      item: imageItem({ result: "", savedPath: undefined }),
    });
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "tool_call"),
    ).toMatchObject({
      item: { status: "failed", error: { message: "Codex finished without an image" } },
    });
  });
});
