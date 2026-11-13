import {
  READ_ALOUD_FULL_MAX_CHARS,
  READ_ALOUD_SUMMARY_MAX_CHARS,
  Settings,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type OneShotPort, ProviderUtilityService, plainSpeech } from "../src/services/utility";

const warnings: string[] = [];

import { sampleSession } from "./helpers";

function fakeOneShot(replies: Record<string, string | Error>, available = ["claude", "codex"]) {
  const calls: Array<{ providerId: string; model?: string }> = [];
  const port: OneShotPort = {
    available: () => available,
    oneShot: async (providerId, req) => {
      calls.push({ providerId, model: req.model });
      const reply = replies[providerId];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error("no reply");
      return reply;
    },
  };
  return { port, calls };
}

const service = (port: OneShotPort, patch: Record<string, unknown> = {}) =>
  new ProviderUtilityService({
    settings: () => Settings.parse(patch),
    oneShot: port,
    warn: (m) => warnings.push(m),
  });

const REPORT = [
  "## Summary",
  "- Rewrote the read-aloud pipeline",
  "- Added a queue for messages",
  ...Array.from({ length: 30 }, (_, i) => `I changed file number ${i} and checked it carefully.`),
  "```ts\ncode()\n```",
].join("\n");

describe("ProviderUtilityService", () => {
  it("titles a session from its first message on Claude by default", async () => {
    const { port, calls } = fakeOneShot({ claude: '"Fix login redirect bug".\n' });
    const title = await service(port).sessionTitle({
      session: sampleSession,
      finalMessage: null,
      firstMessage: "The login page redirects in a loop",
    });
    expect(title).toBe("Fix login redirect bug");
    expect(calls).toEqual([{ providerId: "claude", model: undefined }]);
  });

  it("falls back to Codex when Claude fails, and never throws", async () => {
    const { port, calls } = fakeOneShot({
      claude: new Error("rate limited"),
      codex: "- Add tests\n- Update the README\n3. Run the linter",
    });
    const followups = await service(port).suggestFollowups({
      session: sampleSession,
      finalMessage: "I fixed the bug.",
    });
    expect(followups?.map((f) => f.prompt)).toEqual([
      "Add tests",
      "Update the README",
      "Run the linter",
    ]);
    expect(calls.map((c) => c.providerId)).toEqual(["claude", "codex"]);
    const none = await service(fakeOneShot({}).port).suggestFollowups({
      session: sampleSession,
      finalMessage: "x",
    });
    expect(none).toBeNull();
  });

  it("uses the configured provider and model first", async () => {
    const { port, calls } = fakeOneShot({ codex: "Short title" });
    await service(port, { utilityModel: { provider: "codex", model: "small" } }).sessionTitle({
      session: sampleSession,
      finalMessage: null,
      firstMessage: "hello",
    });
    expect(calls[0]).toEqual({ providerId: "codex", model: "small" });
  });

  it("respects job toggles", async () => {
    const { port, calls } = fakeOneShot({ claude: "x" });
    const off = { utilityModel: { jobs: { sessionTitles: false, followups: false } } };
    const svc = service(port, off);
    expect(
      await svc.sessionTitle({ session: sampleSession, finalMessage: "a", firstMessage: "b" }),
    ).toBeNull();
    expect(await svc.suggestFollowups({ session: sampleSession, finalMessage: "a" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("summarises a handoff's transcript, unless the job is off or nothing answers", async () => {
    const { port, calls } = fakeOneShot({ claude: "  - Built the form\n- Tests fail  " });
    expect(await service(port).handoffSummary("User: Add login\nAgent: Done")).toBe(
      "- Built the form\n- Tests fail",
    );
    expect(calls).toEqual([{ providerId: "claude", model: undefined }]);
    const off = service(port, { utilityModel: { jobs: { handoffSummaries: false } } });
    expect(await off.handoffSummary("User: Add login")).toBeNull();
    expect(await service(port).handoffSummary("  ")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await service(fakeOneShot({}).port).handoffSummary("User: Add login")).toBeNull();
  });

  it("reports when no provider can run the utility model, once", async () => {
    warnings.length = 0;
    const svc = service(fakeOneShot({}, ["fake"]).port);
    await svc.sessionTitle({ session: sampleSession, finalMessage: null, firstMessage: "a" });
    await svc.sessionTitle({ session: sampleSession, finalMessage: null, firstMessage: "b" });
    expect(warnings).toEqual([
      "utility: no provider can run the utility model (runner lists: fake)",
    ]);
  });
});

describe("ProviderUtilityService.speechSummary", () => {
  it("keeps short messages as plain text without a model call", async () => {
    const { port, calls } = fakeOneShot({ claude: "unused" });
    expect(await service(port).speechSummary("**Done.** See `foo`.")).toEqual({
      text: "Done. See foo.",
      source: "plain",
    });
    expect(calls).toHaveLength(0);
  });

  it("speaks the model's TL;DR for a long report", async () => {
    const { port, calls } = fakeOneShot({ claude: "I fixed the bug and added tests." });
    expect(await service(port).speechSummary(REPORT)).toEqual({
      text: "I fixed the bug and added tests.",
      source: "utility",
    });
    expect(calls).toEqual([{ providerId: "claude", model: undefined }]);
  });

  it("caps a rambling TL;DR at two sentences and the character limit", async () => {
    const ramble = `**Done.** I rewrote it. Then ${"also changed more things ".repeat(20)}.`;
    const { text, source } = await service(fakeOneShot({ claude: ramble }).port).speechSummary(
      REPORT,
    );
    expect(source).toBe("utility");
    expect(text).toBe("Done. I rewrote it.");
    const run = await service(fakeOneShot({ claude: "word ".repeat(200) }).port).speechSummary(
      REPORT,
    );
    expect(run.text.length).toBeLessThanOrEqual(READ_ALOUD_SUMMARY_MAX_CHARS);
  });

  it("falls back to a short excerpt, never the report, and logs why", async () => {
    warnings.length = 0;
    const port = fakeOneShot({ claude: new Error("timed out"), codex: new Error("not logged in") });
    const { text, source } = await service(port.port).speechSummary(REPORT);
    expect(source).toBe("plain");
    expect(text.length).toBeLessThanOrEqual(READ_ALOUD_SUMMARY_MAX_CHARS);
    expect(text.startsWith("Summary")).toBe(true);
    expect(warnings).toEqual([
      "utility: read-aloud TL;DR on claude failed: timed out",
      "utility: read-aloud TL;DR on codex failed: not logged in",
      "utility: read-aloud TL;DR unavailable, speaking the message's first sentences",
    ]);
  });

  it("reads the whole cleaned message in full mode, with no model call", async () => {
    const { port, calls } = fakeOneShot({ claude: "unused" });
    const full = { voice: { readAloud: { content: "full" } } };
    const { text, source } = await service(port, full).speechSummary(REPORT);
    expect(source).toBe("plain");
    expect(text).toContain("I changed file number 29 and checked it carefully.");
    expect(text).not.toContain("code()");
    expect(calls).toHaveLength(0);
    const huge = await service(port, full).speechSummary("A long sentence here. ".repeat(500));
    expect(huge.text.length).toBeLessThanOrEqual(READ_ALOUD_FULL_MAX_CHARS);
  });
});

describe("plainSpeech", () => {
  it("strips markdown and code", () => {
    expect(plainSpeech("# Title\n- one\n- [link](http://x)\n```js\nx()\n```\nend")).toBe(
      "Title one link end",
    );
  });
});
