import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  AGENT_EVENT_PREFIX,
  type AgentSkill,
  oneLineDescription,
  type ProviderCommand,
  SessionUpdatedEvent,
  type SlashCommand,
  winningCommands,
} from "@codeden/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { events } from "../../db/schema";
import { filesUnder } from "./discovery";
import { dirsFromRootTo } from "./paths";

/**
 * The composer's `/` menu (§13): the skills and custom commands that apply to a session's
 * working folder, plus the commands its provider reports (built-in, plugin).
 */

/** Names the composer can complete: no whitespace. */
const COMMAND_NAME = /^\S+$/;

/** `description` and `argument-hint` from front matter, else the first line of the body. */
function commandInfo(file: string): { description: string; argumentHint?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8").slice(0, 8_000);
  } catch {
    return { description: "" };
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const field = (key: string) => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm?.[1] ?? "")?.[1]?.trim();
    const unquoted = value?.replace(/^["']|["']$/g, "");
    return unquoted && unquoted !== ">" && unquoted !== "|" ? unquoted : undefined;
  };
  const body = fm ? text.slice(fm[0].length) : text;
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const hint = field("argument-hint");
  return {
    description: oneLineDescription(field("description") ?? firstLine.replace(/^#+\s*/, "")),
    ...(hint ? { argumentHint: oneLineDescription(hint, 80) } : {}),
  };
}

/**
 * Claude Code custom commands in a `commands` folder: `**\/*.md`, named by file, with any
 * subfolders in front (`frontend/fix-issue.md` is `frontend:fix-issue`, as Claude Code
 * reports it).
 */
export function claudeCommandsIn(dir: string): SlashCommand[] {
  return filesUnder(dir).flatMap((file) => {
    const name = relative(dir, file).replace(/\.md$/i, "").split(sep).join(":");
    if (!COMMAND_NAME.test(name)) return [];
    return [{ name, kind: "command" as const, provider: "claude", ...commandInfo(file) }];
  });
}

/**
 * Claude Code's custom commands for a working folder: `.claude/commands` in each folder from
 * `cwd` up to the repository root (nearest first), then `~/.claude/commands`. A project
 * command wins over a user one of the same name.
 */
export function loadedClaudeCommands(
  home: string,
  cwd: string,
  gitRoot: string | null,
): SlashCommand[] {
  const upToRepo = gitRoot ? dirsFromRootTo(gitRoot, cwd).reverse() : [cwd];
  return [
    ...upToRepo.flatMap((d) => claudeCommandsIn(join(d, ".claude", "commands"))),
    ...claudeCommandsIn(join(home, ".claude", "commands")),
  ];
}

/** A discovered skill as a `/` entry. */
export function skillCommand(skill: AgentSkill): SlashCommand {
  return {
    name: skill.name,
    description: oneLineDescription(skill.description ?? ""),
    kind: "skill",
    provider: skill.provider,
  };
}

/** A command the session's provider reported as a `/` entry. */
export function reportedCommand(command: ProviderCommand, provider: string): SlashCommand {
  return {
    name: command.name,
    description: oneLineDescription(command.description),
    kind: "command",
    provider,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  };
}

const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);

/**
 * The `/` list, sorted by name, one entry per name.
 *
 * `discovered` (skills first, then custom commands, in precedence order: the first entry of a
 * name wins) is what the session's files say, and is the list until the provider reports a
 * non-empty one of its own. From then on the provider's list decides which names exist, since
 * it is what `/<name>` runs:
 * - a built-in command is shown as the provider reports it, even if a file shares its name;
 * - any other name keeps what the files say (a skill stays a skill), and the provider fills in
 *   a description or argument hint the files lack.
 */
export function mergeSlashCommands(
  discovered: SlashCommand[],
  reported: ProviderCommand[] | null,
  provider: string,
): SlashCommand[] {
  const files = new Map<string, SlashCommand>();
  for (const entry of discovered) {
    if (COMMAND_NAME.test(entry.name) && !files.has(entry.name)) files.set(entry.name, entry);
  }
  // No report, or an empty one, says nothing about what exists: the files are the list.
  if (!reported || reported.length === 0) return [...files.values()].sort(byName);
  return winningCommands(reported)
    .filter((c) => COMMAND_NAME.test(c.name))
    .map((c) => {
      const own = reportedCommand(c, provider);
      const file = files.get(c.name);
      if (c.builtin === true || !file) return own;
      const argumentHint = file.argumentHint ?? own.argumentHint;
      return {
        ...file,
        description: file.description || own.description,
        ...(argumentHint ? { argumentHint } : {}),
      };
    })
    .sort(byName);
}

/**
 * The newest `/` command list the session's provider reported (`session.updated.commands`
 * in the event log), or null when it never reported one.
 */
export function reportedCommands(db: Db, sessionId: string): ProviderCommand[] | null {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        eq(events.type, `${AGENT_EVENT_PREFIX}session.updated`),
        sql`json_extract(${events.payload}, '$.commands') is not null`,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1)
    .get();
  const parsed = SessionUpdatedEvent.safeParse(row?.payload);
  return parsed.success ? (parsed.data.commands ?? null) : null;
}
