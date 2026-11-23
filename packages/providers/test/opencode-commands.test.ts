import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProviderCommand } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { OpenCodeAdapter } from "../src/opencode/adapter";
import { type OpenCodeClient, OpenCodeHttpError } from "../src/opencode/client";
import {
  commandBody,
  commandFailure,
  OpenCodeCommands,
  routeInput,
  slashHead,
  toProviderCommands,
  withSkill,
} from "../src/opencode/commands";
import { validateEventStream } from "../src/replay/validate";

const known = {
  commands: new Set(["hello", "team/review", "both"]),
  skills: new Set(["pdf", "both"]),
};

describe("OpenCode / input routing", () => {
  it("splits /name from its arguments as OpenCode does", () => {
    expect(slashHead("/hello")).toEqual({ name: "hello", args: "" });
    expect(slashHead("/hello big  world")).toEqual({ name: "hello", args: "big  world" });
    expect(slashHead("/team/review\nline two")).toEqual({ name: "team/review", args: "line two" });
    expect(slashHead("hello /x")).toBeUndefined();
    expect(slashHead("/")).toEqual({ name: "", args: "" });
  });

  it("runs a listed command, attaches a listed skill and sends anything else as a prompt", () => {
    expect(routeInput("/hello world", known)).toEqual({
      type: "command",
      name: "hello",
      args: "world",
    });
    expect(routeInput("/team/review 12", known)).toEqual({
      type: "command",
      name: "team/review",
      args: "12",
    });
    expect(routeInput("/pdf read a.pdf", known)).toEqual({
      type: "skill",
      id: "pdf",
      mention: { start: 0, end: 4, text: "/pdf" },
    });
    // A command wins over a skill of the same name, as in OpenCode.
    expect(routeInput("/both", known)).toMatchObject({ type: "command", name: "both" });
    for (const text of ["/tmp is full", "plain text", "/", " /hello", "/Hello"]) {
      expect(routeInput(text, known)).toEqual({ type: "prompt" });
    }
  });

  it("builds the command and skill request bodies", () => {
    const input = {
      text: "/hello world",
      attachments: [{ type: "file" as const, path: join(tmpdir(), "a.txt"), name: "a.txt" }],
    };
    const route = { type: "command" as const, name: "hello", args: "world" };
    expect(commandBody(route, input)).toMatchObject({
      name: "hello",
      text: "world",
      files: [{ name: "a.txt" }],
    });
    expect(commandBody(route, { text: "/hello", attachments: [] })).toEqual({
      name: "hello",
      text: "world",
    });

    const skill = routeInput("/pdf read", known);
    // Instructions put in front of the text move the mention with it.
    expect(withSkill({ text: "<i/>\n/pdf read" }, skill, 5)).toEqual({
      text: "<i/>\n/pdf read",
      skills: [{ id: "pdf", mention: { start: 5, end: 9, text: "/pdf" } }],
    });
    expect(withSkill({ text: "hi" }, { type: "prompt" })).toEqual({ text: "hi" });
  });

  it("turns a refused command into a failed turn, and leaves other errors alone", () => {
    const notFound = new OpenCodeHttpError(404, "POST …: Command not found: x", {
      _tag: "CommandNotFoundError",
      command: "x",
      message: "Command not found: x",
    });
    expect(commandFailure(notFound, "x")).toMatchObject({
      type: "failed",
      code: "opencode_command_not_found",
      kind: "fatal",
      message: "OpenCode has no /x command.",
    });
    const failed = new OpenCodeHttpError(500, "POST …", {
      _tag: "CommandExecutionError",
      command: "x",
      message: "Shell interpolation failed",
    });
    expect(commandFailure(failed, "x")).toMatchObject({
      code: "opencode_command_failed",
      message: "OpenCode could not run /x: Shell interpolation failed",
    });
    const session = new OpenCodeHttpError(404, "gone", { _tag: "SessionNotFoundError" });
    expect(commandFailure(session, "x")).toBeUndefined();
    expect(commandFailure(new Error("network"), "x")).toBeUndefined();
  });

  it("reports commands, then skills named by id", () => {
    expect(
      toProviderCommands(
        [{ name: "init", description: "setup" }, { name: "legacy" }],
        [{ id: "pdf", name: "PDF tools", path: "/s/pdf/SKILL.md" }],
      ),
    ).toEqual([
      { name: "init", description: "setup", kind: "command" },
      { name: "legacy", description: "", kind: "command" },
      { name: "pdf", description: "", kind: "skill" },
    ]);
  });
});

describe("OpenCode / command list", () => {
  /** A client whose two lists come from `data`; counts the requests. */
  function stubClient(data: { commands: unknown[]; skills: unknown[] } | Error) {
    const paths: string[] = [];
    const client = {
      get: async (path: string) => {
        paths.push(path);
        if (data instanceof Error) throw data;
        return { data: path.startsWith("/api/command") ? data.commands : data.skills };
      },
    } as unknown as OpenCodeClient;
    return { client, paths };
  }

  it("lists both for the working folder, reports changes only, and routes by the list", async () => {
    const reports: ProviderCommand[][] = [];
    const commands = new OpenCodeCommands("C:\\work tree", (c) => reports.push(c));
    expect(commands.route("/hello")).toEqual({ type: "prompt" });
    const data = { commands: [{ name: "hello" }], skills: [] as unknown[] };
    const { client, paths } = stubClient(data);
    await commands.refresh(client);
    expect(paths).toEqual([
      `/api/command?location[directory]=${encodeURIComponent("C:\\work tree")}`,
      `/api/skill?location[directory]=${encodeURIComponent("C:\\work tree")}`,
    ]);
    expect(commands.route("/hello x")).toMatchObject({ type: "command", name: "hello" });
    await commands.refresh(client);
    expect(reports).toHaveLength(1);
    data.skills = [{ id: "pdf", name: "PDF", path: "/p" }];
    await commands.refresh(client);
    expect(reports.at(-1)?.map((c) => c.name)).toEqual(["hello", "pdf"]);
    expect(commands.route("/pdf")).toMatchObject({ type: "skill", id: "pdf" });
  });

  it("lists once more when asked during a listing, and keeps quiet when OpenCode can't list", async () => {
    const reports: ProviderCommand[][] = [];
    const commands = new OpenCodeCommands("/w", (c) => reports.push(c));
    const { client, paths } = stubClient({ commands: [{ name: "a" }], skills: [] });
    await Promise.all([
      commands.refresh(client),
      commands.refresh(client),
      commands.refresh(client),
    ]);
    expect(paths).toHaveLength(4);
    expect(reports).toHaveLength(1);

    const broken = new OpenCodeCommands("/w", (c) => reports.push(c));
    await broken.refresh(stubClient(new OpenCodeHttpError(404, "no route")).client);
    expect(reports).toHaveLength(1);
    expect(broken.route("/a")).toEqual({ type: "prompt" });
  });

  it("holds a first `/name` until OpenCode announces its lists", async () => {
    const commands = new OpenCodeCommands("/w", () => {});
    // Still loading: OpenCode lists its built-ins only.
    const data = { commands: [{ name: "init" }], skills: [] as unknown[] };
    const { client } = stubClient(data);
    await commands.refresh(client);
    let routed: unknown;
    const pending = commands.resolve("/hello world", client).then((r) => {
      routed = r;
    });
    await new Promise((r) => setImmediate(r));
    expect(routed).toBeUndefined();
    // Loaded: `command.updated` arrives and the list has it.
    data.commands = [{ name: "init" }, { name: "hello" }];
    commands.updated(client);
    await pending;
    expect(routed).toEqual({ type: "command", name: "hello", args: "world" });
    // Settled: text that names nothing listed is a prompt at once; listed names never wait.
    await expect(commands.resolve("/tmp is full", client)).resolves.toEqual({ type: "prompt" });
    await expect(commands.resolve("plain", client)).resolves.toEqual({ type: "prompt" });
  });

  it("waits for the lists once at most, when OpenCode never announces them", async () => {
    vi.useFakeTimers();
    try {
      const commands = new OpenCodeCommands("/w", () => {}, 1_000);
      const { client, paths } = stubClient(new OpenCodeHttpError(404, "no route"));
      const first = commands.resolve("/hello", client);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toEqual({ type: "prompt" });
      const listed = paths.length;
      // No second wait; it only lists again.
      await expect(commands.resolve("/hello", client)).resolves.toEqual({ type: "prompt" });
      expect(paths.length).toBe(listed + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------- against the fake `opencode serve`

const fakeOpenCode = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-opencode", "opencode.mjs"),
};

let dir: string;
const sessions: ProviderSession[] = [];
const logFile = () => join(dir, "requests.log");
const requests = (path: RegExp) =>
  (existsSync(logFile()) ? readFileSync(logFile(), "utf8").trim().split("\n") : [])
    .map(
      (line) => JSON.parse(line) as { kind: string; path?: string; query?: string; body?: unknown },
    )
    .filter((r) => r.kind === "request" && path.test(r.path ?? ""));

/** Opens a session and collects its events. */
async function open() {
  const adapter = new OpenCodeAdapter({ executable: fakeOpenCode, noGuardPlugin: true });
  const session = await adapter.openSession({
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
  });
  sessions.push(session);
  const all: AgentEvent[] = [];
  const it = session.events[Symbol.asyncIterator]();
  const until = async (match: (e: AgentEvent) => boolean) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const next = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for an event")),
            deadline - Date.now(),
          ),
        ),
      ]);
      if (next.done) throw new Error("event stream ended");
      all.push(next.value);
      if (match(next.value)) return next.value;
    }
  };
  const turn = async (text: string) => {
    const from = all.length;
    await session.send({ text, attachments: [] });
    await until((e) => e.type === "turn.completed" || e.type === "turn.failed");
    return all.slice(from);
  };
  return { session, all, until, turn };
}

const listed = (e: AgentEvent) =>
  e.type === "session.updated" && !!e.commands?.some((c) => c.name === "hello");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-opencode-cmd-"));
  process.env.FAKE_OPENCODE_LOG = logFile();
  process.env.FAKE_OPENCODE_STATE = join(dir, "state.json");
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_OPENCODE_LOG;
  delete process.env.FAKE_OPENCODE_STATE;
});

describe("OpenCode session / slash commands", () => {
  it("reports OpenCode's commands and skills once they load, for the worktree", async () => {
    const { until } = await open();
    // The first listing has the built-ins only; `command.updated` brings the rest.
    const event = await until(listed);
    expect(event.type === "session.updated" && event.commands).toEqual([
      { name: "init", description: "guided AGENTS.md setup", kind: "command" },
      { name: "hello", description: "Say hello", kind: "command" },
      { name: "team/review", description: "Team review", kind: "command" },
      { name: "broken", description: "Always fails", kind: "command" },
      { name: "opencode", description: "About OpenCode", kind: "skill" },
      { name: "pdf-tools", description: "Work with PDFs", kind: "skill" },
    ]);
    const query = requests(/^\/api\/command$/)[0]?.query ?? "";
    expect(new URLSearchParams(query).get("location[directory]")).toBe(dir);
  });

  it("runs /command through the command route and attaches /skill to the prompt", async () => {
    const { until, turn, all } = await open();
    await until(listed);

    const ran = await turn("/hello big world");
    expect(ran.some((e) => e.type === "turn.completed")).toBe(true);
    expect(requests(/^\/api\/session\/[^/]+\/command$/).map((r) => r.body)).toEqual([
      { name: "hello", text: "big world" },
    ]);
    const message = ran.find((e) => e.type === "item.completed" && e.item.kind === "user_message");
    expect(message?.type === "item.completed" && message.item).toMatchObject({
      input: { text: "/hello big world" },
    });

    await turn("/pdf-tools read a.pdf");
    await turn("/tmp is full");
    expect(requests(/\/prompt$/).map((r) => r.body)).toEqual([
      {
        text: "/pdf-tools read a.pdf",
        skills: [{ id: "pdf-tools", mention: { start: 0, end: 10, text: "/pdf-tools" } }],
      },
      { text: "/tmp is full" },
    ]);
    expect(validateEventStream(all)).toEqual([]);
  });

  it("runs a first message's /command, sent while OpenCode still loads its lists", async () => {
    const { turn } = await open();
    // As the New session draft sends it: right after the session opens.
    const ran = await turn("/hello there");
    expect(ran.some((e) => e.type === "turn.completed")).toBe(true);
    expect(requests(/^\/api\/session\/[^/]+\/command$/).map((r) => r.body)).toEqual([
      { name: "hello", text: "there" },
    ]);
  });

  it("fails the turn with OpenCode's reason when a command can't run", async () => {
    const { until, turn, all } = await open();
    await until(listed);
    const events = await turn("/broken now");
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed?.type === "turn.failed" && failed.error).toMatchObject({
      code: "opencode_command_failed",
      message: "OpenCode could not run /broken: Shell interpolation failed",
    });
    // The user's message is on the failed turn, and the session takes the next message.
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "user_message")).toBe(
      true,
    );
    expect((await turn("/hello")).some((e) => e.type === "turn.completed")).toBe(true);
    expect(validateEventStream(all)).toEqual([]);
  });
});
