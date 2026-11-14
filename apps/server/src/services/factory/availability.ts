import type { ProviderIssue, ProviderStatus, RateLimitWindow } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { RunnerPort } from "../runner-port";

/**
 * Which providers can take new factory work (§10.1, Provider availability). A provider is
 * available unless the runner's `detect()` says it isn't installed, is older than CodeDen runs
 * at all (a `version_unsupported` issue with a `minVersion`) or isn't signed in, its usage
 * service window is `limited` until a reset still ahead, or a factory session on it just failed
 * because of the provider (usage limit, sign-in, a CLI too old, start failure). Detection is
 * cached and refreshed in the background every few minutes; a tick never waits for it, and a
 * provider not detected yet counts as available.
 */

/** Why a provider can't take new work, and until when (null: not known). */
export interface Unavailable {
  reason: string;
  until: string | null;
}

/** Whether a provider can run new work now and, when it can't, why and what fixes it. */
export interface ProviderRunnable {
  runnable: boolean;
  /** Why not, as a phrase after its name: "too old (0.36.0, needs 0.68.0+)", "not signed in". */
  reason: string | null;
  /** When it can run again, when known (a usage limit's reset, a failure's back-off). */
  until: string | null;
  /** What detection says, e.g. "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it." */
  detail: string | null;
  /** The fix detection names: install, sign in or upgrade, with the command to run. */
  fix: ProviderIssue["fix"] | null;
  /**
   * One line to show: "Gemini CLI is too old (0.36.0, needs 0.68.0+): run `npm install -g
   * @google/gemini-cli@latest`". Null when it can run.
   */
  message: string | null;
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

/** Why a provider can't take new work, with the detection issue that explains it. */
interface Blocked {
  unavailable: Unavailable;
  issue: ProviderIssue | null;
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

  /**
   * Detect now and wait for it (joining one already running), whatever the interval: for a
   * person's action, such as Retry right after signing in or updating a CLI.
   */
  async detectNow(): Promise<void> {
    if (!this.running) {
      if (!this.deps.runner.isConnected()) return;
      this.checkedAt = this.deps.now().getTime();
      this.running = this.detect().finally(() => {
        this.running = undefined;
      });
    }
    await this.running;
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
    return this.check(provider)?.unavailable ?? null;
  }

  /**
   * Whether `provider` can run new work now and, when it can't, why, until when, and the fix
   * detection names (the issue's message and command). `name` is the provider's name for the
   * message ("Gemini CLI"). `ignoreFailures` leaves out the back-off after a factory session
   * failed on it (a person's own Retry decides for itself).
   */
  runnable(
    provider: string,
    name = provider,
    opts: { ignoreFailures?: boolean } = {},
  ): ProviderRunnable {
    const found = this.check(provider, opts.ignoreFailures);
    if (!found) {
      return { runnable: true, reason: null, until: null, detail: null, fix: null, message: null };
    }
    const { unavailable: u, issue } = found;
    const fix = issue?.fix ?? null;
    return {
      runnable: false,
      reason: u.reason,
      until: u.until,
      detail: issue?.message ?? null,
      fix,
      message: `${unavailableText(name, u)}${fix ? `: run \`${fix.command}\`` : ""}`,
    };
  }

  /** Why `provider` can't take new work, with the detection issue that explains it, if any. */
  private check(provider: string, ignoreFailures = false): Blocked | null {
    const now = this.deps.now().getTime();
    const status = this.statuses.get(provider);
    const issue = (...codes: ProviderIssue["code"][]) =>
      status?.issues.find((i) => codes.includes(i.code)) ?? null;
    const because = (reason: string, found: ProviderIssue | null, until: string | null = null) => ({
      unavailable: { reason, until },
      issue: found,
    });
    if (status && !status.installed) {
      return because("not installed", issue("not_installed", "broken_install"));
    }
    const tooOld = status?.issues.find((i) => i.code === "version_unsupported" && i.minVersion);
    if (tooOld) {
      const version = status?.version ?? "unknown version";
      return because(`too old (${version}, needs ${tooOld.minVersion}+)`, tooOld);
    }
    if (status && status.loggedIn === false) {
      return because("not signed in", issue("not_logged_in"));
    }
    const limited = this.limitedUntil(provider, now);
    if (limited !== undefined) return because("at its usage limit", null, limited);
    if (ignoreFailures) return null;
    const failed = this.failures.get(provider);
    if (failed?.until && Date.parse(failed.until) > now) {
      return { unavailable: failed, issue: null };
    }
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
