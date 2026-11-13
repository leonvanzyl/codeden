import type { ProviderStatus, RateLimitWindow } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { RunnerPort } from "../runner-port";

/**
 * Which providers can take new factory work (§10.1, Provider availability). A provider is
 * available unless the runner's `detect()` says it isn't installed or isn't signed in, its
 * usage service window is `limited` until a reset still ahead, or a factory session on it just
 * failed because of the provider (usage limit, sign-in, start failure). Detection is cached and
 * refreshed in the background every few minutes; a tick never waits for it, and a provider not
 * detected yet counts as available.
 */

/** Why a provider can't take new work, and until when (null: not known). */
export interface Unavailable {
  reason: string;
  until: string | null;
}

/** A rate-limit window as the usage service stores it. */
export type RateLimitReading = Pick<
  RateLimitWindow,
  "provider" | "status" | "resetsAt" | "observedAt"
>;

export interface ProviderAvailabilityDeps {
  runner: RunnerPort;
  /** Latest rate-limit window of every provider (`UsageService.rateLimitWindows`). */
  rateLimits?: () => RateLimitReading[];
  now: () => Date;
  /** How often detection runs again (default 5 minutes). */
  detectEveryMs?: number;
  log?: (message: string) => void;
}

/** A `limited` reading without a reset time counts for this long after it was seen. */
const LIMITED_WITHOUT_RESET_MS = 60 * 60_000;
/** A provider that failed to start or sign in is skipped for this long (then tried again). */
export const PROVIDER_FAILURE_BACKOFF_MS = 30 * 60_000;

export class ProviderAvailability {
  private statuses = new Map<string, ProviderStatus>();
  private checkedAt = 0;
  private running: Promise<void> | undefined;
  /** Providers a factory session just failed on, until when. */
  private readonly failures = new Map<string, Unavailable>();

  constructor(private readonly deps: ProviderAvailabilityDeps) {}

  /**
   * Start detecting again in the background when the last detection is older than the interval.
   * Never waits: a tick uses what is known, and the result counts from the next tick.
   */
  refresh(): void {
    if (this.running || !this.deps.runner.isConnected()) return;
    const now = this.deps.now().getTime();
    if (now - this.checkedAt < (this.deps.detectEveryMs ?? 5 * 60_000)) return;
    this.checkedAt = now;
    this.running = this.detect().finally(() => {
      this.running = undefined;
    });
  }

  private async detect(): Promise<void> {
    try {
      const res = await this.deps.runner.request(
        { name: "provider.detect", refreshModels: false },
        60_000,
      );
      this.statuses = new Map(res.statuses.map((s) => [s.providerId, s]));
    } catch (error) {
      // Tried again next interval; what was known stays.
      this.deps.log?.(`factory: provider detection failed: ${errorMessage(error)}`);
    }
  }

  /** A factory session failed because of its provider: skip it for new work until `until`. */
  markFailed(provider: string, reason: string, until: string | null): void {
    const at =
      until ?? new Date(this.deps.now().getTime() + PROVIDER_FAILURE_BACKOFF_MS).toISOString();
    this.failures.set(provider, { reason, until: at });
  }

  /** Why `provider` can't take new work now, or null when it can. */
  unavailable(provider: string): Unavailable | null {
    const now = this.deps.now().getTime();
    const status = this.statuses.get(provider);
    if (status && !status.installed) return { reason: "not installed", until: null };
    if (status && status.loggedIn === false) return { reason: "not signed in", until: null };
    const limited = this.limitedUntil(provider, now);
    if (limited !== undefined) return { reason: "at its usage limit", until: limited };
    const failed = this.failures.get(provider);
    if (failed?.until && Date.parse(failed.until) > now) return failed;
    if (failed) this.failures.delete(provider);
    return null;
  }

  /**
   * When the provider's limited windows reset (the latest of them), undefined when none is
   * limited now, null when one is limited without a known reset.
   */
  private limitedUntil(provider: string, now: number): string | null | undefined {
    let latest: string | undefined;
    let unknown = false;
    for (const w of this.deps.rateLimits?.() ?? []) {
      if (w.provider !== provider || w.status !== "limited") continue;
      if (w.resetsAt) {
        const at = Date.parse(w.resetsAt);
        if (at > now && (latest === undefined || at > Date.parse(latest))) latest = w.resetsAt;
      } else if (now - Date.parse(w.observedAt) < LIMITED_WITHOUT_RESET_MS) {
        unknown = true;
      }
    }
    return latest ?? (unknown ? null : undefined);
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "until Tue 06:00" (local time), or "" when the time isn't known. */
export function untilText(until: string | null): string {
  if (!until) return "";
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return ` until ${WEEKDAYS[d.getDay()]} ${hh}:${mm}`;
}

/** "Codex is at its usage limit until Tue 06:00". */
export function unavailableText(name: string, u: Unavailable): string {
  return `${name} is ${u.reason}${untilText(u.until)}`;
}

/** The earliest known time any of these becomes available again (null: none known). */
export function earliestUntil(list: readonly Unavailable[]): string | null {
  const times = list.map((u) => u.until).filter((t): t is string => t !== null);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}
