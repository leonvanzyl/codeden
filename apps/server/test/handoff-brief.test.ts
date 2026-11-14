import type { Item, ItemOf, MessageSender, Session, Turn } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  BRIEF_MAX,
  buildHandoffBrief,
  editedPaths,
  type HandoffSource,
  handoffTranscript,
  TRANSCRIPT_MAX,
} from "../src/services/sessions/handoff-brief";
import type { FileEditCall } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

const WT = "C:\\Users\\dev\\.codeden\\wt\\app\\s1ab";

const session: Session = {
  ...sampleSession,
  title: "Add login",
  purpose: "Add login",
  provider: "claude",
  model: "opus",
  branch: "codeden/add-login-s1ab",
  baseBranch: "main",
  cwd: WT,
  worktreePath: WT,
  issue: { number: 7, title: "Add login", url: "https://github.com/acme/app/issues/7" },
  pr: null,
};

let n = 0;
const user = (text: string, from?: MessageSender, attachments = 0): ItemOf<"user_message"> => ({
  id: `m${++n}`,
  status: "completed",
  kind: "user_message",
  input: {
    text,
    attachments: Array.from({ length: attachments }, (_, i) => ({
      type: "image" as const,
      mediaType: "image/png" as const,
      source: { type: "artifact" as const, artifactId: `a${i}` },
    })),
    ...(from ? { from } : {}),
  },
});
const reply = (text: string): Item => ({
  id: `r${++n}`,
  status: "completed",
  kind: "assistant_message",
  text,
});
const edit = (...paths: string[]): FileEditCall => ({
  id: `e${++n}`,
  status: "completed",
  kind: "tool_call",
  toolKind: "file_edit",
  toolName: "Edit",
  changes: paths.map((path) => ({ path, change: "modify" as const })),
});
const command = (cmd: string): Item => ({
  id: `c${++n}`,
  status: "completed",
  kind: "tool_call",
  toolKind: "command",
  toolName: "Bash",
  command: cmd,
});

function source(patch: Partial<HandoffSource> = {}): HandoffSource {
  return {
    session,
    providerName: "Claude Code",
    restored: true,
    requests: [user("Add a login page with email and password")],
    lastReply: "I added the form; the tests still fail on the redirect.",
    todos: null,
    lastTurn: null,
    edits: [],
    summary: null,
    ...patch,
  };
}

const sectionOrder = (brief: string) =>
  brief
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.replace(/ \(.*\)$/, ""));

describe("the handoff brief", () => {
  it("says where it comes from, then the task, progress and what to do next, in order", () => {
    const brief = buildHandoffBrief(
      source({
        requests: [user("Add a login page"), user("Use OAuth instead of passwords")],
        edits: [edit(`${WT}\\src\\login.tsx`)],
        summary: "- Built the form\n- Redirect test fails",
        note: "Fix the redirect test first.",
      }),
    );
    expect(sectionOrder(brief)).toEqual([
      "## The task",
      "## Later requests",
      "## Where it got to",
      "## Files it edited",
      "## What to do next",
    ]);
    expect(brief).toMatch(
      /^You are taking over a coding task from another CodeDen session, "Add login" \(Claude Code · opus\)/,
    );
    expect(brief).toContain(
      "your branch starts from its branch `codeden/add-login-s1ab`, with the uncommitted changes it had restored",
    );
    expect(brief).toContain("Issue: #7 Add login (https://github.com/acme/app/issues/7)");
    expect(brief).toContain("## The task\n\nAdd a login page");
    expect(brief).toContain("- Use OAuth instead of passwords");
    // The utility summary wins over the last reply.
    expect(brief).toContain("- Built the form\n- Redirect test fails");
    expect(brief).not.toContain("tests still fail on the redirect");
    expect(brief).toContain("- src/login.tsx");
    expect(brief).toContain("## What to do next (from the user)\n\nFix the redirect test first.");
    expect(
      brief.trimEnd().endsWith("(`git status`, `git diff main`) before relying on this brief."),
    ).toBe(true);
  });

  it("quotes the last reply without a summary, and says to continue without a note", () => {
    const brief = buildHandoffBrief(source({ restored: false }));
    expect(brief).toContain(
      "Its last reply:\n\n> I added the form; the tests still fail on the redirect.",
    );
    expect(brief).toContain("## What to do next\n\nContinue the work where it left off.");
    expect(brief).not.toContain("uncommitted changes");
    expect(brief).not.toContain("## Later requests");
    expect(brief).not.toContain("## Files it edited");
    expect(buildHandoffBrief(source({ lastReply: null }))).toContain("It didn't reply yet.");
  });

  it("leaves CodeDen's own messages out of the later requests, and counts what it leaves out", () => {
    const later = Array.from({ length: 12 }, (_, i) => user(`request ${i + 1}`));
    const brief = buildHandoffBrief(
      source({
        requests: [
          user("The task", "factory"),
          user("Previous turn stopped (usage limit); continue where you left off.", "codeden"),
          ...later,
          user("Checks failed on abc123", "codeden"),
        ],
      }),
    );
    // The first message is the task whoever sent it, quoted under them when it isn't the
    // user's; CodeDen's wake-ups are not requests.
    expect(brief).toContain("## The task\n\nFrom the software factory:\n> The task");
    expect(brief).not.toContain("Previous turn stopped");
    expect(brief).not.toContain("Checks failed");
    expect(brief).toContain("## Later requests (2 earlier left out)");
    expect(brief).not.toContain("- request 2\n");
    expect(brief).toContain("- request 3");
    expect(brief).toContain("- request 12");
  });

  it("clips long messages and notes attachments it can't carry", () => {
    const brief = buildHandoffBrief(
      source({
        requests: [user("t".repeat(5_000), undefined, 2), user(`x${"y".repeat(700)}`, "pm", 1)],
      }),
    );
    expect(brief).toContain(`${"t".repeat(3_999)}…\n(2 attachments not included here)`);
    expect(brief).not.toContain("t".repeat(4_001));
    expect(brief).toContain(
      `- From the project manager:\n  > x${"y".repeat(598)}…\n  (1 attachment not included here)`,
    );
  });

  it("adds the recorded result, open todos and a failed last turn", () => {
    const turn: Turn = {
      id: "u3",
      threadId: "t-root",
      sessionId: session.id,
      status: "failed",
      startedAt: "2026-11-14T10:00:00.000Z",
      completedAt: "2026-11-14T10:05:00.000Z",
      error: { kind: "usage_limit", message: "You've hit your usage limit" },
    };
    const brief = buildHandoffBrief(
      source({
        session: {
          ...session,
          result: { outcome: "partial", summary: "Form done, redirect open.", at: turn.startedAt },
        },
        todos: {
          id: "todo",
          status: "in_progress",
          kind: "todo_list",
          todos: [
            { text: "Build the form", status: "completed" },
            { text: "Fix the redirect", status: "in_progress" },
            { text: "Write docs", status: "pending" },
          ],
        },
        lastTurn: turn,
      }),
    );
    expect(brief).toContain("Its recorded result: **partial**. Form done, redirect open.");
    expect(brief).toContain(
      "Still open on its todo list:\n- Fix the redirect (in progress)\n- Write docs",
    );
    expect(brief).not.toContain("Build the form");
    expect(brief).toContain("Its last turn failed: You've hit your usage limit");
  });

  it("lists each edited file once, relative to the worktree, and counts the rest", () => {
    const edits = [
      edit(`${WT}\\src\\a.ts`, "src/b.ts"),
      edit(`${WT.toLowerCase()}/src/a.ts`),
      edit("/elsewhere/notes.md"),
      ...Array.from({ length: 55 }, (_, i) => edit(`${WT}\\gen\\f${i}.ts`)),
    ];
    expect(editedPaths(edits.slice(0, 3), WT)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "/elsewhere/notes.md",
    ]);
    const brief = buildHandoffBrief(source({ edits }));
    expect(brief).toContain("- src/a.ts\n- src/b.ts\n- /elsewhere/notes.md\n- gen/f0.ts");
    expect(brief).toContain("- gen/f46.ts\n- and 8 more");
    expect(brief).not.toContain("gen/f47.ts");
  });

  it("stays within its limit and always keeps the intro and the closing", () => {
    const brief = buildHandoffBrief(
      source({
        requests: [
          user("t".repeat(4_000)),
          ...Array.from({ length: 10 }, () => user("r".repeat(600))),
        ],
        summary: "s".repeat(4_000),
        edits: Array.from({ length: 50 }, (_, i) => edit(`${WT}\\${"d".repeat(200)}\\f${i}.ts`)),
        note: "n".repeat(4_000),
      }),
    );
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(brief).toContain("…(brief shortened)");
    expect(brief.startsWith("You are taking over")).toBe(true);
    expect(brief).toContain(`## What to do next (from the user)\n\n${"n".repeat(4_000)}`);
  });
});

describe("the transcript the summary is written from", () => {
  it("keeps the task and the newest lines, without CodeDen's messages", () => {
    const items: Item[] = [
      user("Add a login page"),
      reply("Looking at the router."),
      command("pnpm test"),
      edit(`${WT}\\src\\login.tsx`),
      user("retry", "codeden"),
      reply("Done."),
    ];
    expect(handoffTranscript(items, WT)).toBe(
      [
        "User: Add a login page",
        "Agent: Looking at the router.",
        "$ pnpm test",
        "Edited: src/login.tsx",
        "Agent: Done.",
      ].join("\n"),
    );
    const many = [
      user("The task"),
      ...Array.from({ length: 200 }, (_, i) => reply(`${i} ${"z".repeat(1_000)}`)),
    ];
    const text = handoffTranscript(many, WT);
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_MAX);
    expect(text.startsWith("User: The task\nAgent: ")).toBe(true);
    expect(text.endsWith(`199 ${"z".repeat(1_000)}`)).toBe(true);
    expect(text).not.toContain("Agent: 0 ");
  });

  it("leads with the task even when the newest items no longer reach back to it", () => {
    const task = user("Add a login page");
    // Only the newest items were read: they start with a wake-up from CodeDen.
    const window: Item[] = [
      user("Previous turn stopped; continue where you left off.", "codeden"),
      reply("Picking up the redirect."),
      command("pnpm test"),
    ];
    expect(handoffTranscript(window, WT, task)).toBe(
      ["User: Add a login page", "Agent: Picking up the redirect.", "$ pnpm test"].join("\n"),
    );
    // And it isn't repeated when the window does reach it.
    expect(handoffTranscript([task, reply("On it.")], WT, task)).toBe(
      "User: Add a login page\nAgent: On it.",
    );
  });
});
