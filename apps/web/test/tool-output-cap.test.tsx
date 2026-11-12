import {
  type AgentEvent,
  OUTPUT_PREVIEW_CHARS,
  type ToolOutput,
  type ToolOutputResponse,
} from "@codeden/contracts";
import { act, fireEvent, screen } from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "@/components/thread/work/tool-row";
import { WorkGroup } from "@/components/thread/work/work-group";
import type { CodeDenClient } from "@/lib/api";
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
    // The server's copy is itself capped: it kept 64 KB of the 2 MB the command printed.
    const getToolOutput = vi.fn(async (_: string, itemId: string) => ({
      itemId,
      text: "older lines\n…the last lines\nTests 412 passed\n",
      totalBytes: 64_000,
      truncated: true,
      outputBytes: 2_000_000,
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

interface LiveProps<S> {
  initial: S;
  view: (state: S) => ReactElement;
  setter: { set?: (state: S) => void };
}

function Live<S>({ initial, view, setter }: LiveProps<S>) {
  const [state, set] = useState(initial);
  setter.set = set;
  return view(state);
}

/** Render `view(state)`; the returned setter changes the state the way live events do. */
function renderLive<S>(initial: S, view: (state: S) => ReactElement, client: CodeDenClient) {
  const setter: LiveProps<S>["setter"] = {};
  renderWithClient(<Live initial={initial} view={view} setter={setter} />, client);
  return (state: S) => act(() => setter.set?.(state));
}

/** A command still streaming, whose transcript copy is cut. */
const running = (id: string, tail: string, totalBytes = 50_000): WorkEntry => ({
  id,
  kind: "tool_call",
  toolKind: "command",
  status: "in_progress",
  toolName: "Bash",
  command: `run ${id}`,
  output: { text: tail, truncated: true, totalBytes },
});

const stored = (itemId: string): ToolOutputResponse => ({
  itemId,
  text: `FULL OUTPUT FROM ${itemId}`,
  totalBytes: 50_000,
  truncated: false,
  outputBytes: 50_000,
});

describe("a loaded output belongs to its own tool call", () => {
  const done: WorkEntry = {
    id: "done",
    kind: "tool_call",
    toolKind: "command",
    status: "completed",
    toolName: "Bash",
    command: "pnpm build",
  };
  const finished = (e: WorkEntry): WorkEntry => ({ ...e, status: "completed" });
  const a = running("a", "a tail\n");
  const b = running("b", "b tail\n");

  it("isn't shown on the next running command once it takes over the work group", async () => {
    const getToolOutput = vi.fn(async (_: string, itemId: string) => stored(itemId));
    const setEntries = renderLive(
      [done, a],
      (entries) => <WorkGroup sessionId="s1" entries={entries} live />,
      { ...createMockClient(), getToolOutput },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(await screen.findByText("FULL OUTPUT FROM a")).toBeTruthy();

    setEntries([done, finished(a), b]);
    expect(screen.getByText("b tail")).toBeTruthy();
    expect(screen.queryByText(/FULL OUTPUT FROM a/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show full output" })).toBeTruthy();
    expect(getToolOutput.mock.calls.map(([, itemId]) => itemId)).toEqual(["a"]);
  });

  it("isn't shown on the next running command when it arrives after the switch", async () => {
    let answerA: (r: ToolOutputResponse) => void = () => {};
    const getToolOutput = vi.fn((_: string, itemId: string) =>
      itemId === "a"
        ? new Promise<ToolOutputResponse>((resolve) => {
            answerA = resolve;
          })
        : Promise.resolve(stored(itemId)),
    );
    const setEntries = renderLive(
      [done, a],
      (entries) => <WorkGroup sessionId="s1" entries={entries} live />,
      { ...createMockClient(), getToolOutput },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();

    setEntries([done, finished(a), b]);
    expect(screen.queryByText("Loading…")).toBeNull();
    await act(async () => answerA(stored("a")));
    // B's own load lands after A's answer, so A's has had every chance to show by then.
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(await screen.findByText("FULL OUTPUT FROM b")).toBeTruthy();
    expect(screen.queryByText(/FULL OUTPUT FROM a/)).toBeNull();
  });
});

describe("a loaded output of a running command", () => {
  it("is described by what the server had when it was loaded, as more output arrives", async () => {
    // At 20,000 bytes the server still has all of it (its cap is 64,000 characters).
    const getToolOutput = vi.fn(async (_: string, itemId: string) => ({
      itemId,
      text: `${"x".repeat(19_990)}live tail\n`,
      totalBytes: 20_000,
      truncated: false,
      outputBytes: 20_000,
    }));
    const setEntry = renderLive(
      running("c", "live tail\n", 20_000),
      (entry) => <ToolRow sessionId="s1" entry={entry} />,
      { ...createMockClient(), getToolOutput },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(await screen.findByText("Output so far · 19.5 KB")).toBeTruthy();

    // The command writes 10,000 more bytes: still nothing lost, only newer than the snapshot.
    setEntry(running("c", "newer tail\n", 30_000));
    expect(screen.getByText("Output when loaded · 19.5 KB · more has arrived since")).toBeTruthy();
    expect(screen.queryByText(/wasn't stored/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to live output" }));
    expect(await screen.findByText("Showing 11 B of 29.3 KB")).toBeTruthy();
    expect(screen.getByText("newer tail")).toBeTruthy();
  });
});
