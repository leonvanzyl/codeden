import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSession } from "../src/acp/session";
import { CURSOR_AGENT } from "../src/cursor/adapter";
import { chunk, fakeAcp, fakeAgent, isTurnEnd, Reader } from "./support/fake-acp";

/**
 * Issue #243: Stop pressed while `send()` is still starting the agent CLI. Stopping a running
 * prompt (`session/cancel`) is covered in `cursor-session.test.ts`.
 */

const acp = fakeAcp();
const sessions: AcpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const rootTurnEnd = (e: AgentEvent) => isTurnEnd(e) && e.threadId.endsWith(":thread-root");
const prompts = () =>
  acp.logged("session/prompt").map((m) => (m.params.prompt as { text: string }[])[0]?.text);

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A session that isn't started yet, so `send()` starts the agent itself, as it does when the
 * agent has exited since the last turn. The agent holds its answer to `hold` until `release()`.
 */
function slowStart(hold: string, extra: Partial<SessionOptions> = {}) {
  const gate = join(acp.dir, "gate");
  const opts = acp.options([chunk("Editing files now.")], {
    ...extra,
    env: { FAKE_ACP_HOLD: hold, FAKE_ACP_GATE: gate },
  });
  const session = new AcpSession(opts, { executable: fakeAgent, spec: CURSOR_AGENT });
  sessions.push(session);
  /** Answer the held request; "exit" makes the agent exit instead. */
  const release = (content = "") => {
    // Renamed into place, so the agent never reads it half-written.
    writeFileSync(`${gate}.tmp`, content);
    renameSync(`${gate}.tmp`, gate);
  };
  return { session, reader: new Reader(session), release };
}

describe("Stop while the ACP agent is starting", () => {
  it.each([
    ["the handshake", "initialize", {}],
    ["session/new", "session/new", {}],
    ["session/load", "session/load", { resumeToken: "sess-old" }],
  ])("during %s: the turn ends at once and its prompt is never sent", async (_, hold, extra) => {
    const { session, reader, release } = slowStart(hold, extra);
    const sending = session.send({ text: "Refactor the parser", attachments: [] });
    await waitFor(() => acp.logged(hold).length > 0);

    await session.interrupt();
    // The turn ends while the agent is still held, with the message that was stopped.
    const end = await reader.until(rootTurnEnd);
    expect(end).toMatchObject({ type: "turn.interrupted", reason: "user" });
    expect(reader.all).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({ kind: "user_message" }),
      }),
    );
    release();
    await sending;
    expect(prompts()).toEqual([]);

    // Stop with nothing running changes nothing, and the next message runs.
    await session.interrupt();
    const next = await reader.turn("Now just read it");
    expect(next.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(prompts()).toEqual(["Now just read it"]);
  });

  it("a start that fails after Stop leaves the turn stopped, not failed", async () => {
    const { session, reader, release } = slowStart("initialize");
    const sending = session.send({ text: "Refactor the parser", attachments: [] });
    await waitFor(() => acp.logged("initialize").length > 0);
    await session.interrupt();
    await reader.until(rootTurnEnd);
    release("exit");
    await expect(sending).resolves.toBeUndefined();

    // The next message starts the agent again.
    await reader.turn("Try again");
    expect(reader.all.filter(rootTurnEnd).map((e) => e.type)).toEqual([
      "turn.interrupted",
      "turn.completed",
    ]);
    expect(prompts()).toEqual(["Try again"]);
  });
});
