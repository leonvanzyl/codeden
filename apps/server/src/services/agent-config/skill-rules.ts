import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, patch, stringify } from "@decimalturn/toml-patch";
import { errorMessage, ServiceError } from "../errors";
import { lineComment, sameComments } from "./toml-comments";

/**
 * Codex's skill switch (§12.4): `[[skills.config]]` entries in `~/.codex/config.toml`, each
 * selecting a skill by `path` (its `SKILL.md`) or `name`, with `enabled`. Entries apply in
 * order and the last one that selects a skill decides it. Only `skills.config` is changed;
 * the rest of the file is kept.
 */

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** The skill a rule is matched against. */
export interface RuleSkill {
  name: string;
  /** Absolute path of its `SKILL.md`. */
  path: string;
}

const fold = (p: string) => {
  const abs = resolve(p);
  return process.platform === "linux" ? abs : abs.toLowerCase();
};

/** True when a rule entry selects the skill: by path when it has one, else by name. */
export function selects(entry: unknown, skill: RuleSkill): boolean {
  if (!isTable(entry) || typeof entry.enabled !== "boolean") return false;
  if (typeof entry.path === "string") return fold(entry.path) === fold(skill.path);
  return typeof entry.name === "string" && entry.name === skill.name;
}

const unparsable = (file: string, why: string) =>
  new ServiceError(422, "config_unparsable", `${file} could not be parsed: ${why}`);

interface Loaded {
  text: string | null;
  doc: Table;
  /** The current `skills.config` entries (empty when there are none). */
  rules: unknown[];
}

function load(file: string): Loaded {
  if (!existsSync(file)) return { text: null, doc: {}, rules: [] };
  const text = readFileSync(file, "utf8");
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw unparsable(file, errorMessage(error));
  }
  if (!isTable(doc)) throw unparsable(file, "not a table");
  if (doc.skills !== undefined && !isTable(doc.skills)) {
    throw unparsable(file, "`skills` is not a table");
  }
  const config = isTable(doc.skills) ? doc.skills.config : undefined;
  if (config !== undefined && !Array.isArray(config)) {
    throw unparsable(file, "`skills.config` is not a list");
  }
  return { text, doc, rules: config ?? [] };
}

/** The rules in a config file; none when it is missing or can't be parsed. */
export function readRules(file: string): unknown[] {
  try {
    return load(file).rules;
  } catch {
    return [];
  }
}

/** Whether the rules leave a skill on, and whether any of them selects it. */
export function ruleState(rules: unknown[], skill: RuleSkill): { enabled: boolean; set: boolean } {
  let enabled = true;
  let set = false;
  for (const entry of rules) {
    if (!selects(entry, skill)) continue;
    enabled = (entry as Table).enabled === true;
    set = true;
  }
  return { enabled, set };
}

/** A switch as a change to the rule list: the entries to drop (by index) and one to append. */
export interface RuleChange {
  drop: Set<number>;
  append: Table | null;
}

/**
 * What a switch does to the rules. Off: drop this skill's own entries of the selector used and
 * append one with `enabled = false`, by path for a user skill and by name for a project skill
 * (a project skill's path differs in every worktree). On: drop every entry that selects it.
 */
export function ruleChange(
  rules: unknown[],
  skill: RuleSkill,
  byPath: boolean,
  enabled: boolean,
): RuleChange {
  const indices = (pick: (entry: unknown) => boolean) =>
    new Set(rules.flatMap((entry, i) => (pick(entry) ? [i] : [])));
  if (enabled) return { drop: indices((entry) => selects(entry, skill)), append: null };
  const same = (entry: unknown) =>
    isTable(entry) &&
    (byPath
      ? typeof entry.path === "string" && fold(entry.path) === fold(skill.path)
      : entry.path === undefined && entry.name === skill.name);
  const append = byPath
    ? { path: skill.path, enabled: false }
    : { name: skill.name, enabled: false };
  return { drop: indices(same), append };
}

/** The rule list after a change. */
export function applyRuleChange(rules: unknown[], change: RuleChange): unknown[] {
  const kept = rules.filter((_, i) => !change.drop.has(i));
  return change.append ? [...kept, change.append] : kept;
}

/** One `[[skills.config]]` block, as lines. */
function block(entry: Table): string[] {
  const lines = Object.entries(entry).map(([k, v]) => stringify({ [k]: v }).trim());
  return ["[[skills.config]]", ...lines];
}

const TABLE_HEADER = /^\s*\[/;
const RULE_HEADER = /^\s*\[\[\s*skills\s*\.\s*config\s*\]\]\s*(#.*)?$/;
/** Whole-line comment and blank lines: never removed by a text edit. */
const KEPT = /^\s*(#.*)?$/;
const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";

/**
 * Edit the `[[skills.config]]` blocks as text: a dropped entry loses its header and setting
 * lines, while every comment and blank line stays. A comment at the end of a dropped line stays
 * on a line of its own, indented like it (blank lines left doubled by the removal are
 * collapsed). An appended entry goes after the last remaining block, or at the end of the file.
 * Returns null when the entries aren't all written as such blocks (an inline array, say).
 */
function textEdit(text: string, rules: unknown[], change: RuleChange): string | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (RULE_HEADER.test(line) ? [i] : []));
  if (starts.length !== rules.length) return null;
  /** Dropped lines, each with what replaces it: its own comment, or nothing. */
  const dropped = new Map<number, string | null>();
  const drop = (i: number) => {
    const line = lines[i] ?? "";
    const comment = lineComment(line);
    dropped.set(i, comment === null ? null : `${/^\s*/.exec(line)?.[0] ?? ""}${comment}`);
  };
  starts.forEach((start, k) => {
    if (!change.drop.has(k)) return;
    drop(start);
    for (let i = start + 1; i < lines.length && !TABLE_HEADER.test(lines[i] ?? ""); i++) {
      if (!KEPT.test(lines[i] ?? "")) drop(i);
    }
  });
  const out: string[] = [];
  let removedSinceText = false;
  lines.forEach((line, i) => {
    const replacement = dropped.get(i);
    if (replacement !== undefined) {
      removedSinceText = replacement === null;
      if (replacement !== null) out.push(replacement);
      return;
    }
    if (isBlank(line) && removedSinceText && (out.length === 0 || isBlank(out.at(-1)))) return;
    out.push(line);
    if (!isBlank(line)) removedSinceText = false;
  });
  if (!change.append) return out.join(eol);

  const added = block(change.append);
  const lastRule = out.findLastIndex((line) => RULE_HEADER.test(line));
  if (lastRule < 0) {
    while (out.length && isBlank(out.at(-1))) out.pop();
    return [...out, ...(out.length ? [""] : []), ...added, ""].join(eol);
  }
  // After the last setting line of the last remaining block.
  let at = lastRule;
  for (let i = lastRule + 1; i < out.length && !TABLE_HEADER.test(out[i] ?? ""); i++) {
    if (!KEPT.test(out[i] ?? "")) at = i;
  }
  const next = out[at + 1];
  out.splice(at + 1, 0, "", ...added, ...(next !== undefined && !isBlank(next) ? [""] : []));
  return out.join(eol);
}

/** Plain JSON view for comparisons (dates become strings). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** A document for comparisons: plain JSON, and an empty `[skills]` table counts as none. */
function normalize(value: Table): Table {
  const doc = plain(value) as Table;
  if (isTable(doc.skills) && Object.keys(doc.skills).length === 0) delete doc.skills;
  return doc;
}

/**
 * The file text before and after a switch. The `[[skills.config]]` blocks are edited as text
 * (`textEdit`); when the entries are written some other way, the TOML library patches the
 * document. Either way the result must parse to the expected document and hold exactly the
 * same comments, whole-line and after values alike (`sameComments`), or the switch is refused
 * (422 `config_edit_unsafe`) rather than lose part of the file.
 */
export function renderRuleSwitch(file: string, skill: RuleSkill, byPath: boolean, on: boolean) {
  const { text, doc, rules } = load(file);
  const before = text ?? "";
  const existed = text !== null;
  const change = ruleChange(rules, skill, byPath, on);
  const next = applyRuleChange(rules, change);
  if (isDeepStrictEqual(plain(next), plain(rules))) {
    return { before, after: before, existed, changed: false };
  }
  const skills = isTable(doc.skills) ? { ...doc.skills } : {};
  if (next.length) skills.config = next;
  else delete skills.config;
  const expected = normalize({ ...doc, skills });

  const safe = (candidate: string | null): candidate is string => {
    if (candidate === null || !sameComments(before, candidate)) return false;
    try {
      return isDeepStrictEqual(normalize(parse(candidate) as Table), expected);
    } catch {
      return false;
    }
  };
  const edited = textEdit(before, rules, change);
  if (safe(edited)) return { before, after: edited, existed, changed: true };
  const patched = patch(before, expected);
  if (safe(patched)) return { before, after: patched, existed, changed: true };
  throw new ServiceError(
    422,
    "config_edit_unsafe",
    `CodeDen can't change the skill settings in ${file} without losing other settings or comments; edit it by hand`,
  );
}
