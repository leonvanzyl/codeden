import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "@decimalturn/toml-patch";
import {
  type GeminiMode,
  type GeminiPolicyRule,
  type GeminiRuleSources,
  geminiUserRules,
  type RankedRule,
} from "./policy-rules";

/**
 * The admin policy CodeDen starts Gemini CLI with (`--admin-policy`, §11.2). Gemini CLI turns
 * its settings' allow-lists (`tools.allowed`, MCP servers marked `trust` or listed in
 * `mcp.allowed`) and user and workspace policy files into rules that run tools without asking.
 * Admin rules outrank all of them, so with these Gemini CLI still asks before every command,
 * and before every edit and MCP tool outside plan mode, and CodeDen's approval policy decides
 * each one. In plan mode Gemini CLI's own plan rules stay in charge of edits and MCP tools (they
 * allow its plan file); commands ask there too, and CodeDen lets read-only ones run.
 *
 * Admin rules would outrank the user's own deny rules too, so a second admin file
 * (`geminiUserRulesPolicy`) repeats the user's rules for these tools above CodeDen's, in Gemini
 * CLI's own order, with `allow` turned into `ask_user`: what the user denies stays denied.
 * CodeDen's rules sit at priority 0, below every copy, and stay in a file of their own, so a copy
 * Gemini CLI rejects can never take them with it.
 *
 * Gemini CLI ignores `--admin-policy` when the machine has system policies of its own (a
 * `.toml` in its system policies folder): an administrator's policy wins.
 */
export const GEMINI_ADMIN_POLICY = `# Written by CodeDen for its Gemini CLI sessions; rewritten when a session starts.
# Admin rules outrank the allow rules Gemini CLI builds from settings files and from
# user and workspace policy files, so these tools still ask and CodeDen decides each call.
# The user's own rules for them are repeated above these, in a file of their own.

[[rule]]
toolName = "run_shell_command"
decision = "ask_user"
priority = 0

[[rule]]
toolName = ["write_file", "replace"]
decision = "ask_user"
priority = 0
modes = ["default", "autoEdit", "yolo"]

[[rule]]
toolName = "*"
mcpName = "*"
decision = "ask_user"
priority = 0
modes = ["default", "autoEdit", "yolo"]
`;

const SHELL_TOOL = "run_shell_command";
const EDIT_TOOLS = ["write_file", "replace"];
/** Where CodeDen's rules ask before edits and MCP tools: every mode but `plan`. */
const OUTSIDE_PLAN: GeminiMode[] = ["default", "autoEdit", "yolo"];
/** The priority fraction Gemini CLI reads as a saved "always allow" rule (and may ignore). */
const ALWAYS_ALLOW_PRIORITY = 950;

/** A rule narrowed to some tools and modes; undefined when no mode is left. */
function narrowed(
  rule: GeminiPolicyRule,
  tools: Pick<GeminiPolicyRule, "toolName" | "mcpName">,
  modes: GeminiMode[] | undefined,
): GeminiPolicyRule | undefined {
  const { modes: own, ...rest } = rule;
  const ruleModes = own?.length ? own : undefined;
  const both = !modes ? ruleModes : !ruleModes ? modes : ruleModes.filter((m) => modes.includes(m));
  if (both && !both.length) return undefined;
  return { ...rest, ...tools, ...(both ? { modes: both } : {}) };
}

/**
 * The parts of a rule that fall where CodeDen's rules ask: commands in every mode, and edits and
 * MCP tools outside plan mode. Each part keeps the rule's other conditions, so it matches exactly
 * the calls the rule matches there. A rule with `commandPrefix` or `commandRegex` is about
 * commands only; one with `mcpName` about MCP tools only. Other tools are left to Gemini CLI.
 */
export function scopedRule(rule: GeminiPolicyRule): GeminiPolicyRule[] {
  const commandOnly = rule.commandPrefix !== undefined || rule.commandRegex !== undefined;
  const parts: (GeminiPolicyRule | undefined)[] = [];
  for (const name of [rule.toolName].flat()) {
    if (rule.mcpName !== undefined) {
      parts.push(narrowed(rule, { toolName: name }, OUTSIDE_PLAN));
    } else if (name === "*") {
      parts.push(narrowed(rule, { toolName: SHELL_TOOL }, undefined));
      if (!commandOnly) {
        parts.push(narrowed(rule, { toolName: EDIT_TOOLS }, OUTSIDE_PLAN));
        parts.push(narrowed(rule, { toolName: "*", mcpName: "*" }, OUTSIDE_PLAN));
      }
    } else if (name === SHELL_TOOL) {
      parts.push(narrowed(rule, { toolName: name }, undefined));
    } else if (!commandOnly && (EDIT_TOOLS.includes(name) || name.startsWith("mcp_"))) {
      parts.push(narrowed(rule, { toolName: name }, OUTSIDE_PLAN));
    }
  }
  return parts.filter((part): part is GeminiPolicyRule => part !== undefined);
}

/** The next admin priority down: never below 1 (CodeDen's rules are 0), never the saved-rule one. */
function nextPriority(priority: number): number {
  const next = Math.max(1, priority - 1);
  return next === ALWAYS_ALLOW_PRIORITY ? next - 1 : next;
}

/**
 * The user's rules as admin rules, or undefined when none would change a decision. Rules are
 * sorted as Gemini CLI ranks them (by tier and priority, ties in load order) and get admin
 * priorities from 999 down in that order, so the same rule wins; rules of the same rank share one.
 * `allow` becomes `ask_user`, so an allow-list never skips CodeDen's approvals; `deny` and
 * `ask_user` stay. Asks after the last deny are dropped: CodeDen's own rules already ask there.
 * Pure.
 */
export function geminiUserRulesPolicy(rules: readonly RankedRule[]): string | undefined {
  const sorted = rules
    .map((ranked, index) => ({ ...ranked, index }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  const out: GeminiPolicyRule[] = [];
  let priority = 1000;
  let lastRank: number | undefined;
  for (const { rule, rank } of sorted) {
    const parts = scopedRule(rule);
    if (!parts.length) continue;
    if (rank !== lastRank) priority = nextPriority(priority);
    lastRank = rank;
    for (const part of parts) {
      out.push({
        ...part,
        decision: part.decision === "allow" ? "ask_user" : part.decision,
        priority,
      });
    }
  }
  const lastDeny = out.findLastIndex((rule) => rule.decision === "deny");
  if (lastDeny < 0) return undefined;
  return `# Written by CodeDen for its Gemini CLI sessions: your own Gemini CLI rules for commands,
# edits and MCP tools, in Gemini CLI's order, so what they deny stays denied. Their allow
# rules ask instead, and CodeDen decides. Edit your own rules, not this file.

${stringify({ rule: out.slice(0, lastDeny + 1) })}`;
}

let privateDir: string | undefined;

/**
 * A folder of this process's own in the OS temp directory, made once with `mkdtemp` (owner-only
 * on POSIX), so another user of a shared `/tmp` can't have made it first.
 */
function privateTempDir(): string {
  privateDir ??= mkdtempSync(path.join(tmpdir(), "codeden-gemini-"));
  return privateDir;
}

/**
 * Where CodeDen's policy goes: CodeDen's data directory (the server always sends it), else a
 * private folder in the OS temp directory. The user's rules go beside it.
 */
export function geminiAdminPolicyPath(codedenHome?: string): string {
  const dir = codedenHome ? path.join(codedenHome, "gemini") : privateTempDir();
  return path.join(dir, "admin-policy.toml");
}

/**
 * Write a file unless it already holds `text`. It is replaced whole (written beside it, then
 * renamed), so a session starting meanwhile never reads half of it.
 */
function writeIfChanged(file: string, text: string): string {
  const current = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  })();
  if (current === text) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
  return file;
}

/**
 * Write the admin policy files for a session and return their paths, CodeDen's own first. The
 * user's rules go to a file named by its content, so sessions with different rules (another
 * worktree) never rewrite each other's; none is written when they deny nothing CodeDen asks
 * about. Throws when CodeDen's own file can't be written: a session never starts without it.
 * Rules that can't be read or written leave just that file, as before CodeDen kept them.
 */
export function writeGeminiAdminPolicies(
  codedenHome: string | undefined,
  sources: GeminiRuleSources,
): string[] {
  const file = writeIfChanged(geminiAdminPolicyPath(codedenHome), GEMINI_ADMIN_POLICY);
  try {
    const rules = geminiUserRulesPolicy(geminiUserRules(sources));
    if (!rules) return [file];
    const hash = createHash("sha256").update(rules).digest("hex").slice(0, 16);
    return [file, writeIfChanged(path.join(path.dirname(file), `user-rules-${hash}.toml`), rules)];
  } catch {
    return [file];
  }
}

/** The arguments that start Gemini CLI's ACP server under CodeDen's admin policy files. */
export function geminiSessionArgs(
  base: readonly string[],
  policyFiles: readonly string[],
): string[] {
  return [...base, ...policyFiles.flatMap((file) => ["--admin-policy", file])];
}
