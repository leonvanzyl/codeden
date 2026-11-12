import { defaultSettings, type Settings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  createUpdateGrouper,
  describeUpdates,
  notifiesFor,
  updateLine,
  updateTarget,
} from "@/lib/attention/updates";
import { inboxItem } from "./attention-fixtures";

const notifications = (
  categories: Partial<Settings["notifications"]["categories"]> = {},
): Settings["notifications"] => {
  const base = defaultSettings().notifications;
  return { ...base, categories: { ...base.categories, ...categories } };
};

describe("notifiesFor", () => {
  it("notifies what needs the user, failures and automations, but not factory activity, by default", () => {
    const n = notifications();
    expect(notifiesFor(inboxItem("a", "pr_review", { notify: "needs_you" }), n)).toBe(true);
    expect(notifiesFor(inboxItem("b", "run_failed", { notify: "failure" }), n)).toBe(true);
    expect(notifiesFor(inboxItem("c", "triage", { notify: "automation" }), n)).toBe(true);
    expect(notifiesFor(inboxItem("d", "message", { notify: "factory" }), n)).toBe(false);
    expect(notifiesFor(inboxItem("e", "pr_review", { notify: "factory" }), n)).toBe(false);
  });

  it("follows the category switches", () => {
    const n = notifications({ factory: true, failure: false });
    expect(notifiesFor(inboxItem("a", "message", { notify: "factory" }), n)).toBe(true);
    expect(notifiesFor(inboxItem("b", "run_failed", { notify: "failure" }), n)).toBe(false);
  });

  it("leaves approvals and questions to the sticky attention toast", () => {
    const n = notifications();
    expect(notifiesFor(inboxItem("a", "approval"), n)).toBe(false);
    expect(notifiesFor(inboxItem("q", "question"), n)).toBe(false);
  });
});

describe("updateTarget", () => {
  it("opens a failed run's session", () => {
    expect(updateTarget(inboxItem("f", "run_failed", { sessionId: "s1" }))).toEqual({
      to: "/sessions/$sessionId",
      params: { sessionId: "s1" },
    });
  });

  it("opens anything else, and a failure without a session, at its item in the inbox", () => {
    expect(updateTarget(inboxItem("pr", "pr_review", { sessionId: "s1" }))).toEqual({
      to: "/inbox",
      search: { item: "pr" },
    });
    expect(updateTarget(inboxItem("paused", "run_failed", { sessionId: null }))).toEqual({
      to: "/inbox",
      search: { item: "paused" },
    });
  });
});

describe("updateLine", () => {
  it("uses the first sentence of the body", () => {
    const item = inboxItem("f", "run_failed", {
      title: "Run failed: Fix login",
      body: "The agent stopped after a failed command.\nmore detail",
    });
    expect(updateLine(item)).toBe("The agent stopped after a failed command.");
    const ready = inboxItem("r", "pr_review", {
      title: "Ready to merge: Only trusted reviews reach agents",
      body: "Every factory check passed (tests, review); auto-merge is off. Review the evidence and merge it.",
    });
    expect(updateLine(ready)).toBe(
      "Every factory check passed (tests, review); auto-merge is off.",
    );
    const peer = inboxItem("p", "run_failed", {
      body: "pnpm install hit a peer conflict: @tanstack/react-query@6 needs react@^19.2.",
    });
    expect(updateLine(peer)).toBe(
      "pnpm install hit a peer conflict: @tanstack/react-query@6 needs react@^19.2.",
    );
  });

  it("skips a line that repeats the title, so a decision shows what was decided", () => {
    const item = inboxItem("d", "message", {
      title: "Factory needs you: Deploy the new stack to production?",
      body: "**Question:** Deploy the new stack to production?\n\n**Decision:** Left for the user",
    });
    expect(updateLine(item)).toBe("Decision: Left for the user");
    const pr = inboxItem("pr", "pr_review", {
      title: "Ready for review: PR #93 Fix login redirect",
      body: "Fix login redirect",
    });
    expect(updateLine(pr)).toBeUndefined();
  });

  it("keeps it to one short line and leaves underscores in names alone", () => {
    const long = inboxItem("x", "run_failed", { body: `ENOENT node_modules/${"a".repeat(200)}` });
    const line = updateLine(long) ?? "";
    expect(line.length).toBe(120);
    expect(line.endsWith("…")).toBe(true);
    expect(line.startsWith("ENOENT node_modules/")).toBe(true);
    expect(updateLine(inboxItem("y", "message", { body: null }))).toBeUndefined();
  });
});

describe("describeUpdates", () => {
  it("shows one item as its title and line, with Open going to it", () => {
    const item = inboxItem("f", "run_failed", {
      notify: "failure",
      sessionId: "s1",
      title: "Run failed: Fix login",
      body: "boom",
    });
    expect(describeUpdates([item])).toEqual({
      title: "Run failed: Fix login",
      description: "boom",
      tone: "error",
      action: "Open",
      target: { to: "/sessions/$sessionId", params: { sessionId: "s1" } },
    });
  });

  it("counts a burst by category and opens the inbox", () => {
    const factory = ["a", "b", "c", "d"].map((id) =>
      inboxItem(id, "message", { notify: "factory", title: `Factory decided: ${id}` }),
    );
    expect(describeUpdates(factory)).toEqual({
      title: "4 updates from the factory",
      description: "Latest: Factory decided: d",
      tone: "default",
      action: "Open inbox",
      target: { to: "/inbox", search: {} },
    });
    const mixed = [
      inboxItem("a", "run_failed", { notify: "failure" }),
      inboxItem("b", "triage", { notify: "automation" }),
    ];
    expect(describeUpdates(mixed).title).toBe("2 new inbox items");
  });
});

describe("createUpdateGrouper", () => {
  it("groups updates that arrive within the window into one toast", () => {
    let now = 0;
    const grouper = createUpdateGrouper({ windowMs: 5_000, now: () => now });
    const first = grouper.add(inboxItem("a", "run_failed"));
    now = 3_000;
    const second = grouper.add(inboxItem("b", "run_failed"));
    // Measured from the latest update, so a steady stream stays one toast.
    now = 7_000;
    const third = grouper.add(inboxItem("c", "run_failed"));
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(third.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("starts a new toast after a quiet spell", () => {
    let now = 0;
    const grouper = createUpdateGrouper({ windowMs: 5_000, now: () => now });
    const first = grouper.add(inboxItem("a", "run_failed"));
    now = 5_001;
    const next = grouper.add(inboxItem("b", "run_failed"));
    expect(next.id).not.toBe(first.id);
    expect(next.items.map((i) => i.id)).toEqual(["b"]);
    // The earlier batch it handed out is not changed afterwards.
    expect(first.items.map((i) => i.id)).toEqual(["a"]);
  });
});
