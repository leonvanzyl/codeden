import { type AgentEvent, OUTPUT_PREVIEW_CHARS, type ToolOutput } from "@codeden/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "@/components/thread/work/tool-row";
import { createMockClient } from "@/lib/api/mock";
import { applyAgentEvent, emptyTranscript, threadItems } from "@/lib/transcript/reducer";
import type { WorkEntry } from "@/lib/transcript/timeline";
import { renderWithClient } from "./utils";

const T = "t1";
const U = "u1";

describe("live command output in the browser", () => {
  it("keeps a bounded tail however long the command streams, and says it was cut", () => {
    const CHUNK = 4_000;
    const CHUNKS = 2_000; // 8M characters: a verbose build or test run
    let s = [
      { type: "thread.started", thread: { id: T } },
      { type: "turn.started", threadId: T, turnId: U },
      {
        type: "item.started",
        threadId: T,
        turnId: U,
        item: {
          id: "c",
          kind: "tool_call",
          toolKind: "command",
          status: "in_progress",
          toolName: "Bash",
          command: "pnpm test",
        },
      },
    ].reduce((acc, e) => applyAgentEvent(acc, e as AgentEvent), emptyTranscript("s1"));
    const line = (i: number) => `${String(i).padStart(5, "0")}${"x".repeat(CHUNK - 6)}\n`;
    for (let i = 0; i < CHUNKS; i++) {
      s = applyAgentEvent(s, {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "c",
        delta: { type: "tool_output", text: line(i) },
      });
    }
    const item = threadItems(s, T)[0]?.item;
    const output = item?.kind === "tool_call" ? item.output : undefined;
    // Exactly the latest output is kept, capped at the server's preview size.
    const recent = Array.from({ length: 5 }, (_, j) => line(CHUNKS - 5 + j)).join("");
    expect(output?.text).toBe(recent.slice(recent.length - OUTPUT_PREVIEW_CHARS));
    expect(output?.truncated).toBe(true);
    expect(output?.totalBytes).toBe(CHUNK * CHUNKS);
  });
});

describe("cut tool output in the transcript", () => {
  const cut: ToolOutput = {
    text: "…the last lines\nTests 412 passed\n",
    truncated: true,
    totalBytes: 2_000_000,
  };
  const command: WorkEntry = {
    id: "c",
    kind: "tool_call",
    toolKind: "command",
    status: "completed",
    toolName: "Bash",
    command: "pnpm test",
    exitCode: 0,
    output: cut,
  };
  const mcp: WorkEntry = {
    id: "m",
    kind: "tool_call",
    toolKind: "mcp",
    status: "completed",
    toolName: "mcp__docs__fetch",
    server: "docs",
    tool: "fetch",
    output: cut,
  };

  it.each([
    ["a command", command],
    ["another tool", mcp],
  ])("%s says the output was cut and offers the full output", (_, entry) => {
    renderWithClient(<ToolRow sessionId="s1" entry={entry} defaultOpen />);
    expect(screen.getByText(/Tests 412 passed/)).toBeTruthy();
    // "…" is 3 bytes in UTF-8: 35 B shown of the 2,000,000 the command printed.
    expect(screen.getByText("Showing 35 B of 1.9 MB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show full output" })).toBeTruthy();
  });

  it("leaves output that wasn't cut as it was", () => {
    const whole = { ...command, output: { text: "ok\n", truncated: false, totalBytes: 3 } };
    renderWithClient(<ToolRow sessionId="s1" entry={whole} defaultOpen />);
    expect(screen.getByText("ok")).toBeTruthy();
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.queryByRole("button", { name: /full output/i })).toBeNull();
  });

  it("loads the stored output on demand and says when the rest wasn't kept", async () => {
    const client = createMockClient();
    const getToolOutput = vi.fn(async (_: string, itemId: string) => ({
      itemId,
      text: "older lines\n…the last lines\nTests 412 passed\n",
      totalBytes: 64_000,
    }));
    renderWithClient(<ToolRow sessionId="s1" entry={command} defaultOpen />, {
      ...client,
      getToolOutput,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(await screen.findByText(/older lines/)).toBeTruthy();
    expect(getToolOutput).toHaveBeenCalledWith("s1", "c");
    expect(screen.getByText("62.5 KB of 1.9 MB was kept · the rest wasn't stored")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(await screen.findByText("Showing 35 B of 1.9 MB")).toBeTruthy();
    expect(screen.queryByText(/older lines/)).toBeNull();
  });

  it("says when the full output can't be loaded and offers to try again", async () => {
    const client = createMockClient();
    const getToolOutput = vi.fn(async () => {
      throw new Error("Server unreachable");
    });
    renderWithClient(<ToolRow sessionId="s1" entry={command} defaultOpen />, {
      ...client,
      getToolOutput,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load the full output: Server unreachable",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/Tests 412 passed/)).toBeTruthy();
  });
});
