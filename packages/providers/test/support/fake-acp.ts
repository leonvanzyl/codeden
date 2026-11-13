import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach } from "vitest";
import type { ProviderSession } from "../../src/adapter";
import { CursorAdapter } from "../../src/cursor/adapter";

/** The scripted ACP agent (`test/fixtures/fake-acp/agent.mjs`) as the Cursor CLI. */
export const fakeAgent = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "..", "fixtures", "fake-acp", "agent.mjs"),
};

export type Step = Record<string, unknown>;
export type Logged = { method: string; params: Record<string, unknown> & { outcome?: unknown } };
export type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

export const chunk = (text: string, session?: string): Step => ({
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  ...(session ? { session } : {}),
});

export const permission = (toolCall: Record<string, unknown>, sessionId?: string): Step => ({
  request: "session/request_permission",
  params: {
    ...(sessionId ? { sessionId } : {}),
    toolCall,
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  },
});

export const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

export const completedOf = (events: AgentEvent[], kind: string) =>
  events.flatMap((e) => (e.type === "item.completed" && e.item.kind === kind ? [e.item] : []));

/** Reads a session's events, answering approvals and questions with `answer`. */
export class Reader {
  readonly all: AgentEvent[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  answer: (item: Request) => RuntimeResponse | undefined = () => ({
    kind: "approval",
    decision: "allow_once",
  });

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async until(match: (e: AgentEvent) => boolean): Promise<AgentEvent> {
    for (;;) {
      const next = await this.it.next();
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      if (
        e.type === "item.started" &&
        (e.item.kind === "approval_request" || e.item.kind === "user_question")
      ) {
        const response = this.answer(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      if (match(e)) return e;
    }
  }

  /** Send a message and read until the root turn ends (child threads' turns end too). */
  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    await this.until((e) => isTurnEnd(e) && e.threadId.endsWith(":thread-root"));
    return this.all.slice(from);
  }
}

/**
 * A temporary worktree per test, sessions on the fake agent that are closed after each test,
 * and the agent's log (every message CodeDen sent, and every answer to the agent's requests).
 */
export function fakeAcp() {
  let dir = "";
  const sessions: ProviderSession[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-cursor-"));
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });
  const logFile = () => join(dir, "acp.log");

  const acp = {
    get dir() {
      return dir;
    },
    logged(method?: string): Logged[] {
      return existsSync(logFile())
        ? readFileSync(logFile(), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Logged)
            .filter((m) => !method || m.method === method)
        : [];
    },
    options(script: Step[], extra: Partial<SessionOptions> = {}): SessionOptions {
      const file = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(script));
      return {
        sessionId: "s1",
        role: "agent",
        cwd: dir,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
        ...extra,
        env: { FAKE_ACP_LOG: logFile(), FAKE_ACP_SCRIPT: file, ...extra.env },
      };
    },
    async open(script: Step[], extra: Partial<SessionOptions> = {}) {
      const adapter = new CursorAdapter({ executable: fakeAgent });
      const session = await adapter.openSession(acp.options(script, extra));
      sessions.push(session);
      return { session, reader: new Reader(session), adapter };
    },
  };
  return acp;
}
