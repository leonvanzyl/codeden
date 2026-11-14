import { CODEDEN_VERSION } from "@codeden/contracts";
import { Octokit } from "@octokit/rest";
import { errorMessage, ServiceError } from "../errors";
import type { GithubAuth, GithubToken } from "./auth";

/** GitHub is not connected (no `gh` login and no keychain token), or rejected the token. */
export class GithubNotConnectedError extends ServiceError {
  constructor(message = "GitHub is not connected. Run `gh auth login`.") {
    super(409, "github_not_connected", message);
    this.name = "GithubNotConnectedError";
  }
}

/** The primary or secondary rate limit was hit; retry after `resetAt` (epoch ms). */
export class GithubRateLimitError extends ServiceError {
  constructor(readonly resetAt: number) {
    super(
      503,
      "github_rate_limited",
      `GitHub rate limit reached until ${new Date(resetAt).toISOString()}`,
    );
    this.name = "GithubRateLimitError";
  }
}

/** Result of a conditional GET: fresh data with its ETag, or `304 Not Modified`. */
export type ConditionalResult<T> = { status: 200; data: T; etag: string | null } | { status: 304 };

export interface GithubClientDeps {
  auth: GithubAuth;
  /** `fetch` used by Octokit (tests pass a fake GitHub). */
  fetch?: typeof fetch;
  /** API base URL (default `https://api.github.com`). */
  baseUrl?: string;
}

interface HttpErrorLike {
  status: number;
  message: string;
  response?: { headers?: Record<string, string | number | undefined>; data?: unknown };
}

function httpError(error: unknown): HttpErrorLike | null {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return error as HttpErrorLike;
  }
  return null;
}

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Octokit with CodeDen's auth handling (§9): the token comes from `GithubAuth` on every call
 * (never stored), a 401 refreshes it once, rate limits become `GithubRateLimitError`, and other
 * failures become `ServiceError`s with GitHub's message.
 */
export class GithubClient {
  private current: { token: string; octokit: Octokit } | null = null;

  constructor(private readonly deps: GithubClientDeps) {}

  /** Run `fn` with an authenticated Octokit. */
  async run<T>(fn: (octokit: Octokit) => Promise<T>): Promise<T> {
    const token = await this.deps.auth.token();
    if (!token) throw new GithubNotConnectedError(this.deps.auth.lastReason() ?? undefined);
    try {
      return await fn(this.octokit(token));
    } catch (error) {
      if (httpError(error)?.status !== 401) throw toGithubError(error);
      // The token was revoked or `gh` switched accounts: ask again once.
      this.deps.auth.invalidate(token);
      const fresh = await this.deps.auth.token();
      if (!fresh || fresh.value === token.value) {
        throw new GithubNotConnectedError("GitHub rejected the token. Run `gh auth login` again.");
      }
      try {
        return await fn(this.octokit(fresh));
      } catch (retryError) {
        if (httpError(retryError)?.status === 401) {
          this.deps.auth.invalidate(fresh);
          throw new GithubNotConnectedError(
            "GitHub rejected the token. Run `gh auth login` again.",
          );
        }
        throw toGithubError(retryError);
      }
    }
  }

  /**
   * GET with `If-None-Match`. A `304` costs no rate limit and means nothing changed since the
   * response that produced `etag`.
   */
  conditionalGet<T>(
    route: string,
    params: Record<string, unknown>,
    etag: string | undefined,
  ): Promise<ConditionalResult<T>> {
    return this.run(async (octokit) => {
      try {
        const res = await octokit.request(route, {
          ...params,
          headers: etag ? { "if-none-match": etag } : {},
        });
        const header = res.headers.etag;
        return { status: 200 as const, data: res.data as T, etag: header ? String(header) : null };
      } catch (error) {
        if (httpError(error)?.status === 304) return { status: 304 as const };
        throw error;
      }
    });
  }

  /** A GraphQL query or mutation. */
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.run((octokit) => octokit.graphql<T>(query, variables));
  }

  private octokit(token: GithubToken): Octokit {
    if (this.current?.token !== token.value) {
      this.current = {
        token: token.value,
        octokit: new Octokit({
          auth: token.value,
          userAgent: `codeden/${CODEDEN_VERSION}`,
          baseUrl: this.deps.baseUrl,
          log: silentLog,
          // `request.log` silences @octokit/request's deprecation warnings too.
          request: { log: silentLog, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) },
        }),
      };
    }
    return this.current.octokit;
  }
}

/** How long to wait after a secondary rate limit that doesn't say (GitHub: at least a minute). */
const SECONDARY_LIMIT_WAIT_MS = 60_000;

/** GitHub's messages for a secondary rate limit (formerly "abuse detection"). */
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit|abuse detection/i;

/**
 * Map an Octokit failure to a `ServiceError`. Rate limits become `GithubRateLimitError`: a 429,
 * or a 403 that is out of the primary limit, has `retry-after`, or says it hit a secondary limit
 * (those often come with neither header). The wait is `retry-after`, else the primary limit's
 * reset when it is used up, else a minute.
 */
export function toGithubError(error: unknown): Error {
  if (error instanceof ServiceError) return error;
  const http = httpError(error);
  if (!http)
    return new ServiceError(502, "github_error", `GitHub request failed: ${errorMessage(error)}`);
  const headers = http.response?.headers ?? {};
  const message = githubMessage(http);
  const primary = String(headers["x-ratelimit-remaining"]) === "0";
  const retryAfter = headers["retry-after"];
  const limited =
    http.status === 429 ||
    (http.status === 403 &&
      (primary || retryAfter !== undefined || SECONDARY_LIMIT_MESSAGE.test(message)));
  if (limited) {
    const now = Date.now();
    const seconds = Number(retryAfter); // NaN without the header, or when it isn't a number
    const primaryReset = primary ? Number(headers["x-ratelimit-reset"] ?? 0) * 1000 : 0;
    const resetAt =
      seconds >= 0
        ? now + seconds * 1000
        : primaryReset > now
          ? primaryReset
          : now + SECONDARY_LIMIT_WAIT_MS;
    return new GithubRateLimitError(resetAt);
  }
  if (http.status === 404) return new ServiceError(404, "github_not_found", message);
  if (http.status === 403) return new ServiceError(403, "github_forbidden", message);
  if (http.status === 409) return new ServiceError(409, "github_conflict", message);
  if (http.status === 422) return new ServiceError(422, "github_validation", message);
  if (http.status === 405) return new ServiceError(409, "github_not_allowed", message);
  return new ServiceError(502, "github_error", message);
}

function githubMessage(http: HttpErrorLike): string {
  const data = http.response?.data as
    | { message?: string; errors?: Array<{ message?: string }> }
    | undefined;
  const details = (data?.errors ?? []).map((e) => e.message).filter(Boolean);
  const base = data?.message ?? http.message;
  return details.length > 0 ? `GitHub: ${base} (${details.join("; ")})` : `GitHub: ${base}`;
}
