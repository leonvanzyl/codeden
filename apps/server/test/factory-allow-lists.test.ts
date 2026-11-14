import {
  AGENT_ALLOW_LIST_NOTICE,
  type FactoryItem,
  type InboxItem,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  ALLOW_LIST_INBOX_PREFIX,
  flagAllowList,
  isAllowListNotice,
} from "../src/services/factory/allow-lists";
import { FACTORY_STARTER } from "../src/services/factory/sessions";

/** Issue #232: a factory session's allow-list warning reaches the item and the inbox. */

const WARNING =
  "This worktree has Cursor's own allow-list, `.cursor/cli.json` (Shell(*)). Cursor runs what it allows without asking.";

const notice = (code: string, sessionId = "s1"): RawEventEnvelope => ({
  seq: 1,
  sessionId,
  ts: "2026-11-14T10:00:00.000Z",
  type: "agent.item.completed",
  payload: {
    type: "item.completed",
    threadId: "t1",
    turnId: "u1",
    item: {
      id: "n1",
      kind: "notice",
      status: "completed",
      level: "warning",
      code,
      message: WARNING,
    },
  },
});

function env(startedBy: Session["startedBy"]) {
  const session = { id: "s1", projectId: "p1", role: "agent", startedBy } as Session;
  let item = {
    id: "i1",
    projectId: "p1",
    title: "Fix the login",
    builderSessionId: "s1",
    reviewerSessionId: null,
    issue: { number: 7, url: "https://github.com/acme/app/issues/7", title: "Login" },
    pr: null,
    note: null,
  } as unknown as FactoryItem;
  const inbox = new Map<string, InboxItem>();
  const ctx = {
    repo: { find: (id: string) => (id === session.id ? { session } : undefined) },
    store: {
      itemForSession: (projectId: string, id: string) =>
        projectId === item.projectId && id === item.builderSessionId ? item : undefined,
      updateItem: (_id: string, change: (i: FactoryItem) => FactoryItem) => {
        item = change(item);
        return item;
      },
    },
    inbox: { find: (id: string) => inbox.get(id), put: (i: InboxItem) => inbox.set(i.id, i) },
    now: () => new Date("2026-11-14T10:00:00.000Z"),
  };
  return { ctx: ctx as never, inbox, item: () => item };
}

describe("flagAllowList", () => {
  it("puts a factory session's allow-list warning on its item and in the inbox", () => {
    const { ctx, inbox, item } = env(FACTORY_STARTER);
    expect(isAllowListNotice(notice(AGENT_ALLOW_LIST_NOTICE))).toBe(true);
    expect(flagAllowList(ctx, notice(AGENT_ALLOW_LIST_NOTICE))).toBe(true);
    expect(item().note).toBe(WARNING);
    expect(inbox.get(`${ALLOW_LIST_INBOX_PREFIX}i1`)).toMatchObject({
      kind: "message",
      notify: "needs_you",
      priority: "high",
      status: "open",
      sessionId: "s1",
      title: 'Factory: "Fix the login" runs with the agent\'s own allow-list',
      body: WARNING,
      issue: { number: 7 },
    });
  });

  it("leaves other notices, sessions the user started and unknown sessions alone", () => {
    const factory = env(FACTORY_STARTER);
    expect(isAllowListNotice(notice("provider_notice"))).toBe(false);
    expect(flagAllowList(factory.ctx, notice("provider_notice"))).toBe(false);
    expect(flagAllowList(factory.ctx, notice(AGENT_ALLOW_LIST_NOTICE, "other"))).toBe(false);
    const user = env({ kind: "user" });
    expect(flagAllowList(user.ctx, notice(AGENT_ALLOW_LIST_NOTICE))).toBe(false);
    expect(user.inbox.size).toBe(0);
  });
});
