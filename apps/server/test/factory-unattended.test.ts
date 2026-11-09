import type { InboxItem, Project, RawEventEnvelope, Session } from "@codeden/contracts";
import { FactoryLimits } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildDigest } from "../src/services/factory/digest";
import {
  builderPrompt,
  discoveryPrompt,
  triageInstructions,
} from "../src/services/factory/prompts";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import {
  answerProviderQuestion,
  DECISION_INBOX_PREFIX,
  isUnattended,
  UNATTENDED_ANSWER,
} from "../src/services/factory/unattended";

const project = (autonomyMode: Project["autonomyMode"]) => ({ autonomyMode }) as Project;
const session = (over: Partial<Session>): Session =>
  ({
    id: "s1",
    projectId: "p1",
    role: "agent",
    startedBy: { kind: "user", id: null },
    ...over,
  }) as Session;

const factoryAgent = session({ startedBy: FACTORY_STARTER });
const pm = session({ role: "pm" });
const userAgent = session({});

describe("unattended factory sessions (§10.1)", () => {
  it("covers the PM and the factory's own agents in a dark factory only", () => {
    expect(isUnattended(project("dark_factory"), factoryAgent)).toBe(true);
    expect(isUnattended(project("dark_factory"), pm)).toBe(true);
    // Sessions the user started still ask as usual.
    expect(isUnattended(project("dark_factory"), userAgent)).toBe(false);
    // Autopilot hands exceptions to the user, so questions still reach them.
    expect(isUnattended(project("autopilot"), factoryAgent)).toBe(false);
    expect(isUnattended(project("assisted"), pm)).toBe(false);
    expect(isUnattended(undefined, pm)).toBe(false);
  });

  it("tells the agent to decide from the vision and record the decision", () => {
    expect(UNATTENDED_ANSWER).toMatch(/dark factory/);
    expect(UNATTENDED_ANSWER).toMatch(/vision/);
    expect(UNATTENDED_ANSWER).toContain("factory_record_decision");
    expect(UNATTENDED_ANSWER).toContain("needsHuman");
  });
});

describe("answerProviderQuestion", () => {
  const question = (over: Record<string, unknown> = {}): RawEventEnvelope => ({
    seq: 1,
    sessionId: "s1",
    ts: "2026-11-09T10:00:00.000Z",
    type: "agent.item.started",
    payload: {
      type: "item.started",
      threadId: "t1",
      turnId: "u1",
      item: {
        id: "q-item",
        kind: "user_question",
        status: "in_progress",
        requestId: "req-1",
        questions: [
          { id: "a", question: "Which stack?", options: [], multiSelect: false },
          { id: "b", question: "Polish now?", options: [], multiSelect: false },
        ],
        ...over,
      },
    },
  });
  const ctx = (s: Session, mode: Project["autonomyMode"]) => ({
    repo: { find: (id: string) => (id === s.id ? { session: s } : undefined) },
    projects: { get: () => project(mode) },
  });

  it("answers every question of an unattended session at once", async () => {
    const respond = vi.fn(async () => undefined);
    const answered = await answerProviderQuestion(
      ctx(factoryAgent, "dark_factory") as never,
      respond,
      question(),
    );
    expect(answered).toBe(true);
    expect(respond).toHaveBeenCalledWith("s1", {
      requestId: "req-1",
      response: { kind: "answer", answers: { a: [UNATTENDED_ANSWER], b: [UNATTENDED_ANSWER] } },
    });
  });

  it("leaves attended sessions, ask_user questions and other items alone", async () => {
    const respond = vi.fn(async () => undefined);
    expect(
      await answerProviderQuestion(ctx(userAgent, "dark_factory") as never, respond, question()),
    ).toBe(false);
    expect(
      await answerProviderQuestion(ctx(factoryAgent, "autopilot") as never, respond, question()),
    ).toBe(false);
    expect(
      await answerProviderQuestion(
        ctx(factoryAgent, "dark_factory") as never,
        respond,
        question({ deferred: true }),
      ),
    ).toBe(false);
    expect(
      await answerProviderQuestion(
        ctx(factoryAgent, "dark_factory") as never,
        respond,
        question({ status: "completed" }),
      ),
    ).toBe(false);
    expect(
      await answerProviderQuestion(
        ctx(factoryAgent, "dark_factory") as never,
        respond,
        question({ kind: "agent_message" }),
      ),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("factory prompts", () => {
  const item = {
    id: "i1",
    source: "discovery",
    area: "ux",
    title: "Inline edit",
    summary: "Edit tasks in place",
    acceptanceCriteria: ["Double-click edits"],
    issue: null,
  } as never;

  it("puts the vision before the current code in triage", () => {
    const text = triageInstructions([item]);
    expect(text).toMatch(/vision wins over the current code/);
    expect(text).not.toContain("factory_record_decision");
  });

  it("tells an unattended PM never to ask and to record its decisions", () => {
    const text = triageInstructions([item], true);
    expect(text).toMatch(/never ask the user/);
    expect(text).toContain("factory_record_decision");
  });

  it("tells finders and builders not to stop for the user", () => {
    expect(discoveryPrompt({ area: "ux", vision: "v", known: [] })).toMatch(
      /Don't ask the user anything/,
    );
    expect(builderPrompt(item, "v")).toMatch(/Don't stop to ask the user/);
  });
});

describe("digest decisions", () => {
  const inbox = (id: string, priority: InboxItem["priority"], createdAt: string): InboxItem =>
    ({
      id,
      kind: "message",
      status: "open",
      priority,
      title: `Factory decided: ${id}`,
      body: "**Question:** q\n\n**Decision:** Migrate first\n\n**Why:** vision",
      projectId: "p1",
      createdAt,
    }) as InboxItem;

  it("reports the day's decisions and only waits on flagged ones", () => {
    const at = new Date(2026, 10, 9, 12).toISOString();
    const earlier = new Date(2026, 10, 8, 12).toISOString();
    const digest = buildDigest({
      projectId: "p1",
      projectName: "test-todo",
      day: "2026-11-09",
      items: [],
      escalated: [],
      inbox: [
        inbox(`${DECISION_INBOX_PREFIX}a`, "low", at),
        inbox(`${DECISION_INBOX_PREFIX}b`, "high", at),
        inbox(`${DECISION_INBOX_PREFIX}old`, "low", earlier),
      ],
      spend: { usd: 0, tokens: 0 },
      limits: FactoryLimits.parse({}),
      pausedReason: null,
    });
    expect(digest.decisions.map((d) => d.inboxItemId)).toEqual([
      `${DECISION_INBOX_PREFIX}a`,
      `${DECISION_INBOX_PREFIX}b`,
    ]);
    expect(digest.decisions[0]).toMatchObject({ decision: "Migrate first", needsHuman: false });
    expect(digest.decisions[1]?.needsHuman).toBe(true);
    expect(digest.waiting.map((w) => w.inboxItemId)).toEqual([`${DECISION_INBOX_PREFIX}b`]);
    expect(digest.text).toMatch(/Decided on its own \(2\)/);
  });
});
