import type { Project, QuietHours } from "@codeden/contracts";
import { Cron } from "croner";

/** The machine's IANA timezone. */
export function machineTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `tz` is a timezone `Intl` knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Cron automations run in the trigger's timezone, else the project's, else the machine's. */
export function effectiveTimezone(
  project: Pick<Project, "timezone"> | null,
  triggerTz?: string,
): string {
  for (const tz of [triggerTz, project?.timezone ?? undefined]) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return machineTimezone();
}

/** Error message for an invalid cron expression (croner syntax), or null when valid. */
export function cronError(expression: string, timezone?: string): string | null {
  try {
    new Cron(expression, timezone ? { timezone } : {});
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first occurrence strictly after `after`, or null when the pattern never fires again. */
export function nextOccurrence(expression: string, timezone: string, after: Date): Date | null {
  try {
    return new Cron(expression, { timezone }).nextRun(after);
  } catch {
    return null;
  }
}

/** Up to `count` occurrences after `after`. */
export function nextOccurrences(
  expression: string,
  timezone: string,
  count: number,
  after: Date,
): Date[] {
  try {
    return new Cron(expression, { timezone }).nextRuns(count, after);
  } catch {
    return [];
  }
}

function localParts(at: Date, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** `YYYY-MM-DD` of `at` in `tz` (the day a daily cap counts against). */
export function localDay(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:MM` of `at` in `tz`. */
export function localTime(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.hour}:${p.minute}`;
}

/** `YYYY-MM-DD HH:MM` of `at` in `tz` (a clock time to tell the user). */
export function localDateTime(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * True when `at` falls inside the quiet hours `[start, end)`; windows may wrap midnight
 * (`22:00`-`07:00`). Times are in the quiet hours' own timezone, else `fallbackTz`.
 */
export function inQuietHours(quiet: QuietHours, at: Date, fallbackTz: string): boolean {
  const tz = quiet.timezone && isValidTimezone(quiet.timezone) ? quiet.timezone : fallbackTz;
  const now = localTime(at, tz);
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? now >= quiet.start && now < quiet.end
    : now >= quiet.start || now < quiet.end;
}

/** What a persisted next run was computed from; a change recomputes it. */
export function scheduleSignature(expression: string, timezone: string): string {
  return `${expression}|${timezone}`;
}
