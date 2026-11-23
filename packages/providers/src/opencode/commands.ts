import type { ProviderCommand, UserInput } from "@codeden/contracts";
import { type OpenCodeClient, OpenCodeHttpError } from "./client";
import { type OcPromptBody, toPromptBody } from "./config";
import type { TurnOutcome } from "./errors";
import type { OcCommandInfo, OcSkillInfo } from "./protocol";

/**
 * The `/` commands and skills of an OpenCode session (§13): listed from its server
 * (`GET /api/command`, `GET /api/skill`) and reported on `session.updated.commands`, and the
 * route each input takes: a reported command runs through `POST /api/session/:id/command`, a
 * skill goes with the prompt as a `SkillAttachment`, anything else is a plain prompt.
 */

/** Where in the prompt text an attachment was named (`text` is that slice). */
export interface OcMention {
  start: number;
  end: number;
  text: string;
}

/** How one input is sent. */
export type OpenCodeRoute =
  | { type: "command"; name: string; args: string }
  | { type: "skill"; id: string; mention: OcMention }
  | { type: "prompt" };

/** A prompt body with skills attached (`PromptInput.SkillAttachment`: the skill's id). */
export type OcSkillPromptBody = OcPromptBody & { skills?: { id: string; mention?: OcMention }[] };

/**
 * `/<name> <arguments>` as OpenCode's own composer splits it: the name runs to the first space,
 * tab or line break, and the arguments are everything after that one character.
 */
export function slashHead(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const end = text.slice(1).search(/[ \t\r\n]/);
  if (end === -1) return { name: text.slice(1), args: "" };
  return { name: text.slice(1, end + 1), args: text.slice(end + 2) };
}

/**
 * The route for `text`: a command OpenCode reported wins over a skill of the same name (as in
 * OpenCode), and a name it didn't report stays a prompt (`/tmp is full` is just text).
 */
export function routeInput(
  text: string,
  known: { commands: ReadonlySet<string>; skills: ReadonlySet<string> },
): OpenCodeRoute {
  const head = slashHead(text);
  if (!head?.name) return { type: "prompt" };
  if (known.commands.has(head.name)) return { type: "command", name: head.name, args: head.args };
  if (known.skills.has(head.name)) {
    const token = `/${head.name}`;
    return { type: "skill", id: head.name, mention: { start: 0, end: token.length, text: token } };
  }
  return { type: "prompt" };
}

/**
 * The prompt body with the route's skill attached. `offset` is how far the typed text moved
 * (instructions put in front of it), so the mention still points at `/<name>`.
 */
export function withSkill(body: OcPromptBody, route: OpenCodeRoute, offset = 0): OcSkillPromptBody {
  if (route.type !== "skill") return body;
  const { start, end, text } = route.mention;
  const mention = { start: start + offset, end: end + offset, text };
  return { ...body, skills: [{ id: route.id, mention }] };
}

/** `POST /api/session/:id/command` body: the arguments as text, with the input's files. */
export function commandBody(
  route: Extract<OpenCodeRoute, { type: "command" }>,
  input: UserInput,
): { name: string; text: string; files?: OcPromptBody["files"] } {
  const { files } = toPromptBody(input);
  return { name: route.name, text: route.args, ...(files ? { files } : {}) };
}

/**
 * Run a command in the session (`sessionPath`: `/api/session/:id`). OpenCode answers once the
 * prompt it expands to is queued, like a prompt, and runs it as an execution of the session.
 * Returns the failure for a command it refused; any other error throws.
 */
export async function runCommand(
  client: OpenCodeClient,
  sessionPath: string,
  route: Extract<OpenCodeRoute, { type: "command" }>,
  input: UserInput,
): Promise<TurnOutcome | undefined> {
  try {
    await client.post(`${sessionPath}/command`, commandBody(route, input));
    return undefined;
  } catch (error) {
    const failed = commandFailure(error, route.name);
    if (failed) return failed;
    throw error;
  }
}

/**
 * A command OpenCode refused, as a failed turn: 404 `CommandNotFoundError` (the list changed
 * since it was read) or 500 `CommandExecutionError` (its template or callback failed).
 * Undefined for any other error.
 */
export function commandFailure(error: unknown, name: string): TurnOutcome | undefined {
  if (!(error instanceof OpenCodeHttpError)) return undefined;
  const body = (error.body ?? {}) as { _tag?: unknown; message?: unknown };
  const detail = typeof body.message === "string" ? body.message : error.message;
  if (body._tag === "CommandNotFoundError") {
    return {
      type: "failed",
      code: "opencode_command_not_found",
      kind: "fatal",
      message: `OpenCode has no /${name} command.`,
      detail,
    };
  }
  if (body._tag === "CommandExecutionError") {
    return {
      type: "failed",
      code: "opencode_command_failed",
      kind: "fatal",
      message: `OpenCode could not run /${name}: ${detail}`,
    };
  }
  return undefined;
}

/** The lists as `ProviderCommand`s: commands first, then skills (named by id). */
export function toProviderCommands(
  commands: readonly OcCommandInfo[],
  skills: readonly OcSkillInfo[],
): ProviderCommand[] {
  return [
    ...commands.map((c) => ({
      name: c.name,
      description: c.description ?? "",
      kind: "command" as const,
    })),
    ...skills.map((s) => ({
      name: s.id,
      description: s.description ?? "",
      kind: "skill" as const,
    })),
  ];
}

/**
 * The session's commands and skills, as last listed. `refresh()` lists them again (at start-up
 * and on `command.updated` / `skill.updated`, which OpenCode sends once a location's lists have
 * loaded and whenever they change) and reports the list when it changed.
 */
export class OpenCodeCommands {
  private known = { commands: new Set<string>(), skills: new Set<string>() };
  private reported: string | undefined;
  private loading: Promise<void> | undefined;
  private again = false;
  /** OpenCode announced its lists (or waiting for them timed out once): no more waiting. */
  private settled = false;
  private readonly waiting = new Set<() => void>();

  constructor(
    /** The session's working directory (the `location` both lists are read for). */
    private readonly directory: string,
    private readonly report: (commands: ProviderCommand[]) => void,
    /** Longest wait for OpenCode's first lists when a message names something not listed. */
    private readonly settleTimeoutMs = 5_000,
  ) {}

  route(text: string): OpenCodeRoute {
    return routeInput(text, this.known);
  }

  /**
   * The route for `text`, once the lists can tell. Right after start-up OpenCode is often still
   * loading them, so a first message like `/review` (from the New session draft) would go out
   * as text: a `/<name>` not listed yet waits for the listing under way and, until OpenCode
   * has announced its lists once, for that announcement (at most `settleTimeoutMs`, once).
   */
  async resolve(text: string, client: OpenCodeClient): Promise<OpenCodeRoute> {
    const name = slashHead(text)?.name;
    const listed = () => !name || this.route(text).type !== "prompt";
    if (listed()) return this.route(text);
    if (this.loading) await this.loading;
    else if (this.known.commands.size === 0) await this.refresh(client);
    if (!listed() && !this.settled) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, this.settleTimeoutMs);
        timer.unref?.();
        this.waiting.add(wake);
      });
      this.settled = true;
    }
    return this.route(text);
  }

  /** OpenCode's `command.updated` / `skill.updated`: list again, then wake anyone waiting. */
  updated(client: OpenCodeClient): void {
    void this.refresh(client).then(() => {
      this.settled = true;
      for (const wake of [...this.waiting]) wake();
    });
  }

  /** List again; a call during a listing runs one more after it. Never throws. */
  refresh(client: OpenCodeClient): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        await this.load(client);
      } while (this.again);
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(client: OpenCodeClient): Promise<void> {
    const location = `location[directory]=${encodeURIComponent(this.directory)}`;
    let commands: OcCommandInfo[];
    let skills: OcSkillInfo[];
    try {
      const [c, s] = await Promise.all([
        client.get<{ data?: OcCommandInfo[] }>(`/api/command?${location}`),
        client.get<{ data?: OcSkillInfo[] }>(`/api/skill?${location}`),
      ]);
      commands = (c?.data ?? []).filter((x) => typeof x?.name === "string" && x.name);
      skills = (s?.data ?? []).filter((x) => typeof x?.id === "string" && x.id);
    } catch {
      // An OpenCode without these routes: `/` text stays a prompt.
      return;
    }
    this.known = {
      commands: new Set(commands.map((c) => c.name)),
      skills: new Set(skills.map((s) => s.id)),
    };
    const list = toProviderCommands(commands, skills);
    const key = JSON.stringify(list);
    if (key === this.reported || list.length === 0) return;
    this.reported = key;
    this.report(list);
  }
}
