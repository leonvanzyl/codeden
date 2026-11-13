import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFailureNote, withSetupNote } from "../src/services/sessions/setup-failure";
import { type Harness, startHarness } from "./support/harness";

describe("setupFailureNote", () => {
  it("names the failed command, its exit code and the end of its output", () => {
    const note = setupFailureNote([
      { command: "pnpm install", exitCode: 0, ok: true },
      { command: "pnpm build", exitCode: 2, ok: false, outputTail: "error TS2304" },
    ]);
    expect(note).toBe("Setup command `pnpm build` failed (exit 2):\n```\nerror TS2304\n```");
    expect(setupFailureNote([{ command: "slow", exitCode: null, ok: false }])).toBe(
      "Setup command `slow` failed (timed out).",
    );
    expect(setupFailureNote([{ command: "ok", exitCode: 0, ok: true }])).toBeNull();
    expect(setupFailureNote(undefined)).toBeNull();
  });

  it("goes in front of the first input, and only when there is one", () => {
    const input = { text: "Fix the bug", attachments: [] };
    expect(withSetupNote(input, "Setup failed.")?.text).toBe("Setup failed.\n\nFix the bug");
    expect(withSetupNote(input, null)).toBe(input);
    expect(withSetupNote(undefined, "Setup failed.")).toBeUndefined();
  });
});

describe("a session whose worktree setup fails", () => {
  let h: Harness;

  beforeAll(async () => {
    const setup = `node -e "console.error('lockfile is out of date'); process.exit(7)"`;
    h = await startHarness({}, { ".codeden/project.json": JSON.stringify({ setup: [setup] }) });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("still starts, and the agent's first message says why setup failed", async () => {
    const id = await h.startFakeSession("Add a test");
    const detail = await h.detail(id);
    expect(detail.startMeta?.setup).toEqual([expect.objectContaining({ status: "failed" })]);
    const thread = detail.session.rootThreadId as string;
    const page = h.server.services.sessionRepo.threadPage(id, thread, { limit: 50 });
    const first = page.items.find((r) => r.item.kind === "user_message")?.item;
    if (first?.kind !== "user_message") throw new Error("no user message");
    expect(first.input.text).toMatch(/^Setup command `node -e .*` failed \(exit 7\):\n```\n/);
    expect(first.input.text).toContain("lockfile is out of date");
    expect(first.input.text.endsWith("\n\nAdd a test")).toBe(true);
  });
});
