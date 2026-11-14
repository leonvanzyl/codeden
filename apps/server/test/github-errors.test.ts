import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { githubRefused } from "../src/services/factory/merge";
import { GithubRateLimitError, toGithubError } from "../src/services/github/client";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The error a real Octokit throws when GitHub answers a merge with this status, body and headers. */
async function octokitError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const octokit = new Octokit({
    auth: "token",
    log: silent,
    request: {
      log: silent,
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json; charset=utf-8", ...headers },
        }),
    },
  });
  try {
    await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner: "o",
      repo: "r",
      pull_number: 1,
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

/** `toGithubError` of that error, with the clock read around it. */
async function mapped(status: number, body: unknown, headers: Record<string, string> = {}) {
  const raw = await octokitError(status, body, headers);
  const before = Date.now();
  const error = toGithubError(raw);
  return { error, before, after: Date.now() };
}

const SECONDARY = {
  message:
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
  documentation_url:
    "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
  status: "403",
};

/** A secondary limit 403 also carries the primary limit's headers, which have room left. */
const PRIMARY_NOT_USED_UP = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4211",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3000),
};

describe("toGithubError", () => {
  it("maps a 403 secondary rate limit without retry headers to a rate limit of a minute, not a refusal", async () => {
    const { error, before, after } = await mapped(403, SECONDARY, PRIMARY_NOT_USED_UP);
    expect((error as { code?: string }).code).toBe("github_rate_limited");
    expect(error).toBeInstanceOf(GithubRateLimitError);
    const { resetAt } = error as GithubRateLimitError;
    expect(resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(resetAt).toBeLessThanOrEqual(after + 60_000);
    expect(githubRefused(error)).toBe(false);
  });

  it("maps the older abuse detection wording to a rate limit too", async () => {
    const { error } = await mapped(403, {
      message:
        "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.",
    });
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect(githubRefused(error)).toBe(false);
  });

  it("waits for retry-after on a 403 secondary rate limit", async () => {
    const { error, before, after } = await mapped(403, SECONDARY, { "retry-after": "120" });
    expect(error).toBeInstanceOf(GithubRateLimitError);
    const { resetAt } = error as GithubRateLimitError;
    expect(resetAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(resetAt).toBeLessThanOrEqual(after + 120_000);
    expect(githubRefused(error)).toBe(false);
  });

  it("waits for the primary limit's reset when it is used up", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const { error } = await mapped(
      403,
      { message: "API rate limit exceeded for user ID 1." },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    );
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).resetAt).toBe(reset * 1000);
    expect(githubRefused(error)).toBe(false);
  });

  it("still maps a plain 403 to github_forbidden, which counts as a refusal", async () => {
    const { error } = await mapped(
      403,
      { message: "Resource not accessible by integration" },
      PRIMARY_NOT_USED_UP,
    );
    expect(error).not.toBeInstanceOf(GithubRateLimitError);
    expect((error as { code?: string }).code).toBe("github_forbidden");
    expect(githubRefused(error)).toBe(true);
  });
});
