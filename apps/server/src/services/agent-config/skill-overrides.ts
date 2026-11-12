import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { SkillVisibility } from "@codeden/contracts";
import { errorMessage, ServiceError } from "../errors";
import type { HookFile } from "./hooks";
import { guard } from "./hooks-service";
import { setTopLevelMember } from "./json-edit";

/**
 * Claude Code's skill switch (§12.4): `skillOverrides` in its settings files maps a skill name
 * to `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`; a name no file sets is `"on"`.
 * The most specific file that sets a name decides it (local, then project, then user). Only
 * the `skillOverrides` value is ever rewritten.
 */

export type OverrideValue = "on" | SkillVisibility | "off";
const VALUES: ReadonlySet<string> = new Set(["on", "name-only", "user-invocable-only", "off"]);

type Native = Record<string, unknown>;
const isRecord = (v: unknown): v is Native =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const unparsable = (file: string, why: string) =>
  new ServiceError(422, "config_unparsable", `${file} could not be parsed: ${why}`);

/** One settings file read for `skillOverrides`. */
export interface OverrideFile {
  source: HookFile;
  /** The known values it sets, by skill name. Empty when the file can't be used. */
  overrides: Map<string, OverrideValue>;
  /** Why the file can't be used (unparsable, or a link leading outside its folder). */
  error?: string;
}

interface Loaded {
  text: string | null;
  doc: Native;
  overrides: Native;
}

function load(file: string): Loaded {
  if (!existsSync(file)) return { text: null, doc: {}, overrides: {} };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { text, doc: {}, overrides: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw unparsable(file, errorMessage(error));
  }
  if (!isRecord(doc)) throw unparsable(file, "not a JSON object");
  const overrides = doc.skillOverrides;
  if (overrides !== undefined && !isRecord(overrides)) {
    throw unparsable(file, "`skillOverrides` is not an object");
  }
  return { text, doc, overrides: overrides ?? {} };
}

/**
 * Read a settings file's overrides. For listing, a file that can't be used sets nothing. With
 * `strict` (planning a switch) its error is thrown instead: 403 `path_outside_root` for a link
 * leading outside its folder, 422 `config_unparsable` for a file that doesn't parse. A switch
 * must never pick its target while a file that applies can't be read, or it could write the
 * wrong file.
 */
export function readOverrides(source: HookFile, strict = false): OverrideFile {
  try {
    guard(source);
    const { overrides } = load(source.file);
    const known = Object.entries(overrides).filter(
      (e): e is [string, OverrideValue] => typeof e[1] === "string" && VALUES.has(e[1]),
    );
    return { source, overrides: new Map(known) };
  } catch (error) {
    if (strict) throw error;
    return { source, overrides: new Map(), error: errorMessage(error) };
  }
}

/**
 * Settings files from highest precedence to lowest, given them lowest first (user, project,
 * local…): local files keep their order (the repository-root one wins over an older one in the
 * working folder), then project, then user.
 */
export function highestFirst<T extends { source: Pick<HookFile, "scope"> }>(files: T[]): T[] {
  const local = files.filter((f) => f.source.scope === "local");
  return [...local, ...files.filter((f) => f.source.scope !== "local").reverse()];
}

/** The file (highest precedence first) that decides a skill name, and its value. */
export function decidingOverride(
  highest: OverrideFile[],
  name: string,
): { file: OverrideFile; value: OverrideValue } | null {
  for (const file of highest) {
    const value = file.overrides.get(name);
    if (value) return { file, value };
  }
  return null;
}

/** The value to write for a switch, and where (`userFile` when no file decides the name). */
export function planOverride(
  files: OverrideFile[],
  userFile: HookFile,
  name: string,
  enabled: boolean,
): { target: HookFile; value: OverrideValue | undefined } {
  const highest = highestFirst(files);
  const deciding = decidingOverride(highest, name);
  const target = deciding?.file.source ?? userFile;
  if (!enabled) return { target, value: "off" };
  // Switching on drops the entry, unless a lower file would then still decide something other
  // than "on"; then the deciding file says "on" explicitly.
  const below = deciding ? highest.slice(highest.indexOf(deciding.file) + 1) : [];
  const lower = decidingOverride(below, name)?.value;
  return { target, value: lower && lower !== "on" ? "on" : undefined };
}

/**
 * The file text before and after setting (or, with `value` undefined, removing) one skill's
 * entry in `skillOverrides`. Everything outside that value is kept byte for byte.
 */
export function renderOverride(file: string, name: string, value: OverrideValue | undefined) {
  const { text, overrides } = load(file);
  // Edited as entries so any skill name (even `__proto__`) stays a plain own key, in place.
  const entries: [string, unknown][] = Object.entries(overrides);
  const at = entries.findIndex(([key]) => key === name);
  if (value === undefined) {
    if (at >= 0) entries.splice(at, 1);
  } else if (at >= 0) entries[at] = [name, value];
  else entries.push([name, value]);
  const next = Object.fromEntries(entries);
  const before = text ?? "";
  const existed = text !== null;
  if (isDeepStrictEqual(next, overrides)) return { before, after: before, existed, changed: false };
  const after = text?.trim()
    ? setTopLevelMember(text, "skillOverrides", next)
    : `${JSON.stringify({ skillOverrides: next }, null, 2)}\n`;
  return { before, after, existed, changed: true };
}
