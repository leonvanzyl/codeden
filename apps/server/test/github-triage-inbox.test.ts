import type { InboxItem } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { triageItemId } from "../src/services/automations/triage";
import { resolveClosedTriage } from "../src/services/github/triage-inbox";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
const P = "p-gh";
const ts = "2026-11-07T10:00:00.000Z";

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => env.close());

/** The open "Should I take this on?" decision for issue `number`, as triage raises it. */
function decision(number: number): InboxItem {
  return env.inbox.put({
    id: triageItemId(P, number),
    kind: "triage",
    status: "open",
    priority: "normal",
    notify: "automation",
    title: `Should I take this on? #${number}`,
    body: "Ready",
    projectId: P,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: { number, url: `https://github.com/acme/widgets/issues/${number}` },
    pr: null,
    automationRunId: null,
    createdAt: ts,
    updatedAt: ts,
    resolvedAt: null,
    resolution: null,
  });
}

const status = (number: number) => env.inbox.find(triageItemId(P, number))?.status;
const waitTick = () => new Promise((r) => setTimeout(r, 20));

/** Triage decisions follow their issue (#673): closing it on GitHub resolves the decision. */
describe("triage decisions of closed issues", () => {
  it("resolves the decision once the sync sees its issue closed, and keeps it when reopened", async () => {
    env.gh.addIssue({ title: "Bug" });
    env.gh.addIssue({ title: "Other" });
    await env.service.syncNow(P);
    env.service.start({ sync: false });
    decision(1);
    decision(2);

    env.gh.touch(1, (i) => {
      i.state = "closed";
      i.closedAt = env.gh.tick();
    });
    await env.service.syncNow(P);
    for (let i = 0; i < 50 && status(1) === "open"; i++) await waitTick();
    expect(env.inbox.find(triageItemId(P, 1))).toMatchObject({
      status: "resolved",
      resolution: { by: "codeden", note: "Issue #1 was closed" },
    });
    expect(status(2)).toBe("open");

    // Reopened: the decision stays in the history; the next triage run raises it again.
    env.gh.touch(1, (i) => {
      i.state = "open";
      i.closedAt = null;
    });
    await env.service.syncNow(P);
    await waitTick();
    expect(status(1)).toBe("resolved");
  });

  it("resolves at start the decisions whose issue was already closed", async () => {
    env.gh.addIssue({ title: "Fixed while CodeDen wasn't following" });
    env.gh.addIssue({ title: "Still open" });
    await env.service.syncNow(P);
    env.gh.touch(1, (i) => {
      i.state = "closed";
      i.closedAt = env.gh.tick();
    });
    await env.service.syncNow(P);
    decision(1);
    decision(2);
    env.service.start({ sync: false });
    expect(status(1)).toBe("resolved");
    expect(status(2)).toBe("open");
  });

  it("says how the issue was closed, and skips decisions already made", () => {
    decision(3);
    const declined = decision(4);
    env.inbox.close(declined, "dismissed", { decision: "decline" });
    const issue = (number: number) => ({
      projectId: P,
      number,
      state: "closed" as const,
      stateReason: "not_planned" as const,
    });
    const settled = resolveClosedTriage(env.inbox, [issue(3), issue(4), issue(5)]);
    expect(settled.map((i) => i.resolution)).toEqual([
      { by: "codeden", note: "Issue #3 was closed as not planned" },
    ]);
    expect(env.inbox.find(triageItemId(P, 4))?.resolution).toEqual({ decision: "decline" });
  });
});
