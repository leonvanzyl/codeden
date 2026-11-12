import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, patch, stringify } from "@decimalturn/toml-patch";
import { errorMessage, ServiceError } from "../errors";

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

/**
 * The rules after a switch. Off: drop this skill's own entries of the selector used and
 * append one with `enabled = false`, by path for a user skill and by name for a project skill
 * (a project skill's path differs in every worktree). On: drop every entry that selects it.
 */
export function switchedRules(
  rules: unknown[],
  skill: RuleSkill,
  byPath: boolean,
  enabled: boolean,
): unknown[] {
  if (enabled) return rules.filter((entry) => !selects(entry, skill));
  const same = (entry: unknown) =>
    isTable(entry) &&
    (byPath
      ? typeof entry.path === "string" && fold(entry.path) === fold(skill.path)
      : entry.path === undefined && entry.name === skill.name);
  const entry = byPath
    ? { path: skill.path, enabled: false }
    : { name: skill.name, enabled: false };
  return [...rules.filter((e) => !same(e)), entry];
}

/** One `[[skills.config]]` block. */
function block(entry: Table): string {
  const lines = Object.entries(entry).map(([k, v]) => stringify({ [k]: v }).trim());
  return ["[[skills.config]]", ...lines].join("\n");
}

/** Plain JSON view for comparisons (dates become strings). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/**
 * The file text before and after a switch. New entries go at the end of the file as
 * `[[skills.config]]` blocks when the file has none yet; otherwise the TOML library patches the
 * document. Either way the result is parsed back and must equal the expected document.
 */
export function renderRuleSwitch(file: string, skill: RuleSkill, byPath: boolean, on: boolean) {
  const { text, doc, rules } = load(file);
  const before = text ?? "";
  const existed = text !== null;
  const next = switchedRules(rules, skill, byPath, on);
  if (isDeepStrictEqual(plain(next), plain(rules))) {
    return { before, after: before, existed, changed: false };
  }
  const skills = isTable(doc.skills) ? { ...doc.skills } : {};
  if (next.length) skills.config = next;
  else delete skills.config;
  const expected: Table = { ...doc, skills };
  if (Object.keys(skills).length === 0) delete expected.skills;

  const matches = (candidate: string) => {
    try {
      return isDeepStrictEqual(plain(parse(candidate)), plain(expected));
    } catch {
      return false;
    }
  };
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (rules.length === 0) {
    const added = next.filter(isTable).map(block).join("\n\n").split("\n").join(eol);
    const head = before.trimEnd();
    const appended = `${head}${head ? `${eol}${eol}` : ""}${added}${eol}`;
    if (matches(appended)) return { before, after: appended, existed, changed: true };
  }
  const patched = patch(before, expected);
  if (!matches(patched)) {
    throw new ServiceError(
      500,
      "config_edit_failed",
      `CodeDen could not edit ${file} without changing other settings; edit it by hand`,
    );
  }
  return { before, after: patched, existed, changed: true };
}
