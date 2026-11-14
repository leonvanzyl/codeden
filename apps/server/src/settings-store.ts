import { existsSync } from "node:fs";
import { Settings, type SettingsPatch } from "@codeden/contracts";
import { readJsonFile, writeJsonFile } from "./json-file";
import { type FileReset, loadUserJsonFile } from "./user-json-file";

/** Loads and saves `<home>/settings.json` (non-secret user settings). */
export class SettingsStore {
  private current: Settings;
  /**
   * Set when the file on disk could not be used (not valid JSON, or invalid settings): it was
   * kept as `settings.json.invalid-<timestamp>` and CodeDen started from defaults.
   */
  readonly reset: FileReset | null;

  constructor(private readonly file: string) {
    const existed = existsSync(file);
    const { value, reset } = loadUserJsonFile(file, Settings);
    if (!existed) writeJsonFile(file, value);
    this.current = value;
    this.reset = reset;
  }

  /** The settings in `file`, or defaults when it is missing or broken. Never writes anything. */
  static read(file: string): Settings {
    const parsed = Settings.safeParse(readJsonFile(file) ?? {});
    return parsed.success ? parsed.data : Settings.parse({});
  }

  get(): Settings {
    return this.current;
  }

  /** Deep-merge a patch, validate, persist and return the new settings. Throws on invalid input. */
  update(patch: SettingsPatch): Settings {
    const merged = deepMerge(this.current, patch);
    const next = Settings.parse(merged);
    writeJsonFile(this.file, next);
    this.current = next;
    return next;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `patch` into `base`. Arrays and primitives replace; `undefined` is skipped;
 * `null` over an object removes the key (so record entries such as per-project overrides can
 * be deleted, and schema defaults refill anything required).
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null && isPlainObject(out[key])) {
      delete out[key];
      continue;
    }
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}
