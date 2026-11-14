import type { Item } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  type Activity,
  activityOf,
  BUBBLE_MIN_MS,
  BUBBLE_SHOW_MS,
  bubbleOf,
  cut,
  NO_ACTIVITY,
  nextChange,
  noteActivity,
  safeCommand,
  TOOL_RECENT_MS,
  tickActivity,
} from "@/components/factory-view/pixel/activity";
import { redactSecrets } from "@/lib/redact";

/**
 * Issue #264 (the user's addition): thought bubbles show what each agent is doing right now,
 * from its live transcript, using only titles, redacted, one per agent and at most one change
 * every two seconds.
 */

const base = { id: "i1", status: "in_progress" as const };
const tool = (patch: Record<string, unknown>) =>
  ({ ...base, kind: "tool_call", toolName: "Tool", ...patch }) as Item;
const text = (a: Activity | null) => (a ? [a.kind, a.text] : null);

describe("bubble text (#264)", () => {
  it("names each kind of tool call by its title", () => {
    const rows = [
      tool({ toolKind: "command", command: "pnpm test -- --run src/theme" }),
      tool({
        toolKind: "file_edit",
        changes: [{ path: "apps/server/src/factory/queue.ts", change: "modify" }],
      }),
      tool({
        toolKind: "file_edit",
        changes: [
          { path: "a.ts", change: "modify" },
          { path: "b.ts", change: "add" },
        ],
      }),
      tool({ toolKind: "file_read", path: "docs/DESIGN.md", startLine: 500 }),
      tool({ toolKind: "search", query: "withReviewer", path: "src" }),
      tool({ toolKind: "web", url: "https://example.com/docs?key=abc#x" }),
      tool({ toolKind: "web", title: "Fetch the Vite changelog", url: "https://vite.dev" }),
      tool({ toolKind: "browser", action: "click", url: "http://localhost:5173" }),
      tool({ toolKind: "mcp", server: "codeden", tool: "report_progress" }),
      tool({ toolKind: "other", toolName: "TodoWrite" }),
    ].map((item) => text(activityOf(item)));
    expect(rows).toEqual([
      ["run", "Run pnpm test"],
      ["edit", "Edit apps/server/src/factory/queue.ts"],
      ["edit", "Edit 2 files"],
      ["read", "Read docs/DESIGN.md"],
      ["search", "Search: withReviewer"],
      ["web", "Web: example.com"],
      ["web", "Fetch the Vite changelog"],
      ["web", "Browser: click"],
      ["run", "codeden · report_progress"],
      ["run", "TodoWrite"],
    ]);
  });

  it("shows a command's program and subcommand only, never its arguments", () => {
    expect(
      [
        "pnpm test",
        "git status --short",
        "cd apps/web && npx vitest run test/x.test.ts",
        "GITHUB_TOKEN=ghp_0123456789abcdefghij0123456789 gh pr checks 59",
        "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com",
        "./scripts/deploy.sh --token s3cr3t",
        'node -e "console.log(process.env.SECRET)"',
        "echo $(cat ~/.npmrc)",
        "   ",
      ].map(safeCommand),
    ).toEqual([
      "pnpm test",
      "git status",
      "npx vitest",
      "gh pr",
      "curl",
      "deploy.sh",
      "node",
      "echo",
      "a command",
    ]);
  });

  it("falls back to a snippet of reasoning or the reply, cut to about 40 characters", () => {
    const long = "I will check whether the reviewer's verdict still applies to the new head commit";
    expect(text(activityOf({ ...base, kind: "reasoning", text: long }))).toEqual([
      "think",
      "I will check whether the reviewer's ver…",
    ]);
    expect(
      text(activityOf({ ...base, kind: "reasoning", text: "", summary: "Planning the fix" })),
    ).toEqual(["think", "Planning the fix"]);
    expect(text(activityOf({ ...base, kind: "reasoning", text: "", redacted: true }))).toEqual([
      "think",
      "Thinking…",
    ]);
    expect(
      text(activityOf({ ...base, kind: "assistant_message", text: "Done:  all\ngreen" })),
    ).toEqual(["think", "Done: all green"]);
  });

  it("ignores what isn't the agent's own doing", () => {
    const user = { ...base, kind: "user_message", input: { text: "hi", attachments: [] } } as Item;
    expect(activityOf(user)).toBeNull();
    expect(activityOf({ ...base, kind: "assistant_message", text: "  " })).toBeNull();
  });

  it("keeps the end of a long path", () => {
    const path = "apps/web/src/components/factory-view/pixel/very-long-file-name.ts";
    const a = activityOf(tool({ toolKind: "file_read", path }));
    expect(a?.text).toBe("Read …view/pixel/very-long-file-name.ts");
    expect(a?.text.length).toBeLessThanOrEqual(40);
    expect(cut("abcdef", 4)).toBe("abc…");
  });

  it("never shows a secret", () => {
    const leaks = [
      activityOf(tool({ toolKind: "search", query: "token=ghp_0123456789abcdefghij0123456789" })),
      activityOf({
        ...base,
        kind: "reasoning",
        text: "Use sk-ant-api03-abcdefghijklmnop0123 here",
      }),
      activityOf(tool({ toolKind: "web", title: "GET https://bot:hunter2@example.com" })),
    ].map((a) => a?.text ?? "");
    for (const t of leaks) {
      expect(t).not.toMatch(/ghp_|sk-ant|hunter2/);
      expect(t).toContain("***");
    }
  });
});

describe("secret redaction (#264)", () => {
  it("masks credentials, tokens, key=value secrets, JWTs and long opaque strings", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(
      [
        "https://user:pa55word@github.com/acme/shop.git",
        "Authorization: Bearer abcdefghijklmnop",
        "API_KEY=abc123 password: 'hunter2'",
        "deploy --token s3cr3t-value",
        `jwt ${jwt}`,
        "sha 3f786850e387550fdab836ed7e6dc881de23001b",
        "xoxb-1234567890-abcdefghij and AKIAABCDEFGHIJKLMNOP",
      ].map(redactSecrets),
    ).toEqual([
      "https://***@github.com/acme/shop.git",
      "Authorization: Bearer ***",
      "API_KEY=*** password: ***",
      "deploy --token ***",
      "jwt ***",
      "sha ***",
      "*** and ***",
    ]);
  });

  it("leaves ordinary text and file paths alone", () => {
    for (const plain of [
      "Search: auth middleware",
      "Read apps/server/src/services/factory/sessions.ts",
      "Run pnpm test",
      "Edit src/theme/tokens.ts",
    ])
      expect(redactSecrets(plain)).toBe(plain);
  });
});

const act = (itemId: string, kind: Activity["kind"] = "run", t = itemId): Activity => ({
  itemId,
  kind,
  text: t,
});

describe("bubble timing (#264)", () => {
  it("shows a new tool call at once, then at most one change every two seconds", () => {
    let s = noteActivity(NO_ACTIVITY, act("a"), 0);
    expect(bubbleOf(s, 0)?.activity.itemId).toBe("a");
    s = noteActivity(s, act("b"), 500);
    s = noteActivity(s, act("c"), 900);
    // Held back: the latest waits for its turn.
    expect(s.pending?.itemId).toBe("c");
    expect(bubbleOf(tickActivity(s, 1999), 1999)?.activity.itemId).toBe("a");
    expect(nextChange(s, 1000)).toBe(BUBBLE_MIN_MS);
    s = tickActivity(s, BUBBLE_MIN_MS);
    expect(bubbleOf(s, BUBBLE_MIN_MS)?.activity.itemId).toBe("c");
    // The card lists the last three, newest first.
    expect(s.history.map((h) => h.itemId)).toEqual(["c", "b", "a"]);
  });

  it("fades a bubble after a few seconds, unless its agent is hovered", () => {
    const s = noteActivity(NO_ACTIVITY, act("a"), 0);
    expect(bubbleOf(s, BUBBLE_SHOW_MS - 1500)).toMatchObject({ fading: false });
    expect(bubbleOf(s, BUBBLE_SHOW_MS - 500)).toMatchObject({ fading: true });
    expect(bubbleOf(s, BUBBLE_SHOW_MS)).toBeNull();
    expect(bubbleOf(s, BUBBLE_SHOW_MS * 3, true)?.activity.itemId).toBe("a");
    expect(nextChange(s, 0)).toBe(BUBBLE_SHOW_MS - 1000);
    expect(nextChange(s, BUBBLE_SHOW_MS - 500)).toBe(BUBBLE_SHOW_MS);
    expect(nextChange(s, BUBBLE_SHOW_MS)).toBeNull();
  });

  it("updates the same item in place, and ignores repeats", () => {
    const s = noteActivity(NO_ACTIVITY, act("r", "think", "Planning"), 0);
    expect(noteActivity(s, act("r", "think", "Planning"), 100)).toBe(s);
    const grown = noteActivity(s, act("r", "think", "Planning the fix"), 300);
    expect(grown.shown?.text).toBe("Planning the fix");
    expect(grown.shownAt).toBe(0);
    expect(grown.history).toHaveLength(1);
  });

  it("doesn't let reasoning push a recent tool call's bubble away", () => {
    const s = noteActivity(NO_ACTIVITY, act("t", "edit"), 0);
    expect(noteActivity(s, act("r", "think"), TOOL_RECENT_MS - 1)).toBe(s);
    const later = noteActivity(s, act("r", "think"), TOOL_RECENT_MS);
    expect(later.shown?.itemId).toBe("r");
  });
});
