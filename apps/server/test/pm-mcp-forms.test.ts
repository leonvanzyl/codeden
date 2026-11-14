import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEventToNewEvent,
  type ItemOf,
  type Notice,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { requestInboxId } from "../src/events/reducer/items";
import { EventStore } from "../src/events/store";
import { ToolError } from "../src/mcp/define";
import { answerQuestion } from "../src/mcp/tools/pm/questions";
import { InboxService } from "../src/services/inbox-service";
import { renderNotices } from "../src/services/orchestration/digest";
import { deriveNotices, formServerOf } from "../src/services/orchestration/notices";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

/**
 * An MCP server's form in work the PM started (#235): its answers are data for an external tool,
 * so like an approval it stays with the user (§8.3, §11.2). The PM is told it waits for the user
 * and `answer_question` refuses it. A real SQLite event log projects the transcript and the
 * inbox; no runner.
 */
describe("the PM and MCP servers' forms", () => {
  let dir: string;
  let db: Database;
  let store: EventStore;
  let repo: SessionRepo;
  let inbox: InboxService;
  let events: RawEventEnvelope[];
  const respond = vi.fn(async () => undefined);

  const session: Session = {
    ...sampleSession,
    id: "s-pm-work",
    projectId: "p1",
    scope: { projectId: "p1" },
    startedBy: { kind: "pm", id: "pm-1" },
    rootThreadId: "t1",
  };

  const deployForm: ItemOf<"user_question"> = {
    id: "question-mcp-1",
    kind: "user_question",
    status: "in_progress",
    requestId: "mcp-1",
    mcpServer: "deploy",
    questions: [
      {
        id: "target",
        header: "Target",
        question: "deploy asks: Where should I deploy? — Target",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
      {
        id: "replicas",
        header: "Replicas",
        question: "Replicas (a whole number)",
        options: [],
        multiSelect: false,
        allowFreeText: true,
        format: "integer",
      },
    ],
  };

  const agentQuestion: ItemOf<"user_question"> = {
    id: "ask-1",
    kind: "user_question",
    status: "in_progress",
    requestId: "ask-1",
    questions: [
      {
        id: "q1",
        question: "Zod or Valibot?",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };

  /** Raise a question item in the session's transcript; returns its inbox item id. */
  const ask = (item: ItemOf<"user_question">): string => {
    store.append([
      agentEventToNewEvent(session.id, {
        type: "item.started",
        threadId: "t1",
        turnId: "u1",
        item,
      }),
    ]);
    return requestInboxId(session.id, item.id);
  };

  const call = (inboxItemId: string, answer: string) =>
    answerQuestion.handler({ inboxItemId, answer }, {
      services: { inbox, sessionRepo: repo, db: db.db, sessions: { respond } },
      projectId: "p1",
      sessionId: "pm-1",
      role: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    } as never);

  /** The PM's "needs input" notices for what was raised, as the orchestration service makes them. */
  const notices = () =>
    deriveNotices(events, {
      session: (id) => repo.find(id)?.session,
      finalMessage: () => null,
      mcpServer: (sessionId, itemId) => formServerOf(repo, sessionId, itemId),
    }).filter((d) => d.notice.type === "session.needs_input");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-pm-forms-"));
    db = openDatabase(join(dir, "codeden.db"));
    store = new EventStore(db.db);
    repo = new SessionRepo(db.db, store);
    inbox = new InboxService(db.db, store, () => async () => {});
    respond.mockClear();
    store.append([
      { type: "session.created", sessionId: session.id, payload: { session } },
      agentEventToNewEvent(session.id, { type: "thread.started", thread: { id: "t1" } }),
      agentEventToNewEvent(session.id, { type: "turn.started", threadId: "t1", turnId: "u1" }),
    ]);
    events = [];
    store.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("refuses the form and leaves it open for the user, sending the server nothing", async () => {
    const inboxItemId = ask(deployForm);
    expect(inbox.get(inboxItemId)).toMatchObject({ kind: "question", status: "open" });

    const refusal = await call(inboxItemId, "Staging, since the brief says this is a trial run")
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(respond).not.toHaveBeenCalled();
    expect(refusal).toBeInstanceOf(ToolError);
    expect((refusal as Error).message).toMatch(/form from the deploy MCP server/);
    expect((refusal as Error).message).toMatch(/stays with the user/);
    expect(inbox.get(inboxItemId).status).toBe("open");
  });

  it("still answers the agent's own question", async () => {
    const inboxItemId = ask(agentQuestion);
    await call(inboxItemId, "Zod: the project already uses it");
    expect(respond).toHaveBeenCalledWith(
      session.id,
      {
        requestId: "ask-1",
        response: { kind: "answer", answers: { q1: ["Zod: the project already uses it"] } },
      },
      "pm",
    );
  });

  it("tells the PM the form waits for the user, and its own agents' questions are its to answer", () => {
    ask(deployForm);
    ask(agentQuestion);
    const [form, own] = notices();
    expect(form?.notice.data).toMatchObject({ kind: "question", mcpServer: "deploy" });
    expect(own?.notice.data).not.toHaveProperty("mcpServer");
    const text = (draft: typeof form) =>
      renderNotices([{ ...(draft?.notice as Notice), createdAt: "", deliveredAt: null }]);
    expect(text(form)).toContain("a form from the deploy MCP server, waiting for the user");
    expect(text(form)).not.toContain("answer it with answer_question");
    expect(text(own)).toContain("answer it with answer_question");
  });
});
