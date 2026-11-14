import { createHash } from "node:crypto";
import { FakeGitData } from "./fake-github-git";
import type { FakeIssue, FakePrFile } from "./fake-github-types";

export type { FakeCheck, FakeIssue, FakePrFile, FakeReview } from "./fake-github-types";

/** In-memory GitHub plugged into Octokit as `fetch`: CodeDen's REST/GraphQL calls, ETags, 401s. */

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  ifNoneMatch: string | null;
  status: number;
}

const OWNER = "acme";
const REPO = "widgets";

export class FakeGithub {
  readonly owner = OWNER;
  readonly repo = REPO;
  issues = new Map<number, FakeIssue>();
  requests: FakeRequest[] = [];
  validTokens = new Set(["tok-1"]);
  /** The account each token signs in as (`/user`, GraphQL `viewer`); default `octo`. */
  accounts = new Map<string, string>();
  rateLimited = false;
  /** Git objects created through the Git Data API. */
  readonly gitData = new FakeGitData();
  private clock = Date.parse("2026-11-01T00:00:00Z");
  private nextNumber = 1;
  private nextId = 1000;

  /** A monotonically increasing timestamp (seconds apart). */
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  addIssue(partial: Partial<FakeIssue> = {}): FakeIssue {
    const now = this.tick();
    const issue: FakeIssue = {
      number: this.nextNumber++,
      title: "An issue",
      body: "",
      state: "open",
      labels: [],
      author: "octo",
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      ...partial,
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  addPr(
    head: string,
    partial: Partial<FakeIssue> = {},
    pr: Partial<NonNullable<FakeIssue["pr"]>> = {},
  ) {
    return this.addIssue({
      title: "A change",
      ...partial,
      pr: {
        head,
        base: "main",
        headSha: `sha-${head}-1`,
        draft: false,
        merged: false,
        mergedAt: null,
        checks: [],
        reviews: [],
        mergeable: "MERGEABLE",
        ...pr,
      },
    });
  }

  /** Change an issue the way GitHub would (bumping `updated_at`). */
  touch(number: number, change: (issue: FakeIssue) => void): void {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    change(issue);
    issue.updatedAt = this.tick();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const body = rawBody ? (JSON.parse(rawBody) as unknown) : null;
    const record: FakeRequest = {
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body,
      ifNoneMatch: headers.get("if-none-match"),
      status: 0,
    };
    this.requests.push(record);
    const respond = (status: number, data: unknown, extra: Record<string, string> = {}) => {
      record.status = status;
      const text = data === null ? null : JSON.stringify(data);
      return new Response(status === 304 ? null : text, {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...extra },
      });
    };
    const token = (headers.get("authorization") ?? "").replace(/^(token|bearer)\s+/i, "");
    if (!this.validTokens.has(token)) return respond(401, { message: "Bad credentials" });
    if (this.rateLimited) {
      return respond(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
        },
      );
    }
    const result = this.route(method, record.path, url.searchParams, body, token);
    if (result.status === 200 && method === "GET") {
      const etag = `"${createHash("sha1").update(JSON.stringify(result.data)).digest("hex")}"`;
      if (record.ifNoneMatch === etag) return respond(304, null, { etag });
      return respond(200, result.data, { etag, ...result.headers });
    }
    return respond(result.status, result.data);
  };

  private route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    token: string,
  ): { status: number; data: unknown; headers?: Record<string, string> } {
    const ok = (data: unknown, status = 200) => ({ status, data });
    const notFound = { status: 404, data: { message: "Not Found" } };
    const b = (body ?? {}) as Record<string, unknown>;
    const login = this.accounts.get(token) ?? "octo";
    if (method === "GET" && path === "/user") return ok({ login });
    if (method === "POST" && path === "/graphql") return ok(this.graphql(String(b.query), login));
    const prefix = `/repos/${OWNER}/${REPO}`;
    if (!path.startsWith(prefix)) return notFound;
    const rest = path.slice(prefix.length);
    let m: RegExpMatchArray | null;

    if (method === "GET" && rest === "/issues") {
      const state = query.get("state") ?? "open";
      const since = query.get("since");
      let list = [...this.issues.values()].filter((i) => state === "all" || i.state === state);
      if (since) list = list.filter((i) => i.updatedAt >= since);
      list.sort(
        (a, b2) =>
          (query.get("direction") === "asc" ? 1 : -1) * a.updatedAt.localeCompare(b2.updatedAt),
      );
      return ok(list.slice(0, Number(query.get("per_page") ?? 30)).map((i) => this.restIssue(i)));
    }
    if (method === "POST" && rest === "/issues") {
      const issue = this.addIssue({
        title: String(b.title),
        body: String(b.body ?? ""),
        labels: (b.labels as string[] | undefined) ?? [],
      });
      return ok(this.restIssue(issue), 201);
    }
    m = rest.match(/^\/issues\/(\d+)$/);
    if (m) {
      const issue = this.issues.get(Number(m[1]));
      if (!issue) return notFound;
      if (method === "PATCH") {
        this.touch(issue.number, (i) => {
          if (b.state === "closed") {
            i.state = "closed";
            i.closedAt = this.tick();
          }
        });
      }
      return ok(this.restIssue(issue));
    }
    m = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (m) {
      const issue = this.issues.get(Number(m[1]));
      if (!issue) return notFound;
      if (method === "GET") {
        return ok(
          issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: c.author },
            created_at: c.createdAt,
            html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}#issuecomment-${c.id}`,
          })),
        );
      }
      const comment = {
        id: this.nextId++,
        body: String(b.body),
        author: "octo",
        createdAt: this.tick(),
      };
      this.touch(issue.number, (i) => i.comments.push(comment));
      return ok(
        {
          id: comment.id,
          body: comment.body,
          html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}#issuecomment-${comment.id}`,
        },
        201,
      );
    }
    m = rest.match(/^\/issues\/(\d+)\/labels$/);
    if (m && method === "POST") {
      const n = Number(m[1]);
      this.touch(n, (i) => {
        for (const l of b.labels as string[]) if (!i.labels.includes(l)) i.labels.push(l);
      });
      return ok([]);
    }
    m = rest.match(/^\/issues\/(\d+)\/labels\/(.+)$/);
    if (m && method === "DELETE") {
      const issue = this.issues.get(Number(m[1]));
      if (!issue?.labels.includes(m[2] ?? "")) return notFound;
      this.touch(issue.number, (i) => {
        i.labels = i.labels.filter((l) => l !== m?.[2]);
      });
      return ok([]);
    }
    if (method === "GET" && rest === "/pulls") {
      const head = (query.get("head") ?? "").split(":").pop();
      const list = [...this.issues.values()].filter(
        (i) => i.pr && i.state === "open" && (!head || i.pr.head === head),
      );
      return ok(list.map((i) => ({ number: i.number })));
    }
    if (method === "POST" && rest === "/pulls") {
      const pr = this.addPr(
        String(b.head),
        { title: String(b.title), body: String(b.body ?? "") },
        { base: String(b.base), draft: Boolean(b.draft) },
      );
      return ok(
        { number: pr.number, html_url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}` },
        201,
      );
    }
    m = rest.match(/^\/pulls\/(\d+)$/);
    if (m) {
      const issue = this.issues.get(Number(m[1]));
      if (!issue?.pr) return notFound;
      if (method === "PATCH")
        this.touch(issue.number, (i) =>
          Object.assign(i, { title: b.title ?? i.title, body: b.body ?? i.body }),
        );
      return ok({
        number: issue.number,
        body: issue.body,
        additions: 3,
        deletions: 1,
        changed_files: prFiles(issue).length,
        head: { sha: issue.pr.headSha, ref: issue.pr.head },
        base: { ref: issue.pr.base },
      });
    }
    m = rest.match(/^\/pulls\/(\d+)\/files$/);
    if (m) {
      const issue = this.issues.get(Number(m[1]));
      if (!issue?.pr) return notFound;
      // Paged like GitHub: `per_page` (max 100) from `page`, with a `Link` to the next page.
      const files = prFiles(issue);
      const perPage = Math.min(Number(query.get("per_page") ?? 30), 100);
      const page = Number(query.get("page") ?? 1);
      const slice = files.slice((page - 1) * perPage, page * perPage);
      if (page * perPage >= files.length) return ok(slice);
      const next = `${prefix}${rest}?per_page=${perPage}&page=${page + 1}`;
      return { ...ok(slice), headers: { link: `<${next}>; rel="next"` } };
    }
    m = rest.match(/^\/pulls\/(\d+)\/merge$/);
    if (m && method === "PUT") {
      const issue = this.issues.get(Number(m[1]));
      if (!issue?.pr) return notFound;
      this.touch(issue.number, (i) => {
        if (!i.pr) return;
        i.pr.merged = true;
        i.pr.mergedAt = this.tick();
        i.state = "closed";
        i.closedAt = i.pr.mergedAt;
      });
      return ok({ merged: true, sha: "merge-sha", method: b.merge_method });
    }
    return this.gitData.route(method, rest, b) ?? notFound;
  }

  private restIssue(i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: `https://github.com/${OWNER}/${REPO}/${i.pr ? "pull" : "issues"}/${i.number}`,
      labels: i.labels.map((name) => ({ name })),
      user: { login: i.author },
      body: i.body,
      comments: i.comments.length,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      closed_at: i.closedAt,
      ...(i.pr ? { pull_request: { url: "x" } } : {}),
    };
  }

  private graphql(query: string, login: string) {
    const repository: Record<string, unknown> = {};
    for (const m of query.matchAll(/pr(\d+): pullRequest\(number: (\d+)\)/g)) {
      const issue = this.issues.get(Number(m[2]));
      repository[`pr${m[1]}`] = issue?.pr ? this.prNode(issue) : null;
    }
    const viewer = /\bviewer\s*\{\s*login\s*\}/.test(query) ? { viewer: { login } } : {};
    return { data: { ...viewer, repository } };
  }

  private prNode(i: FakeIssue) {
    const pr = i.pr as NonNullable<FakeIssue["pr"]>;
    const done = pr.checks.length > 0 && pr.checks.every((c) => c.status === "COMPLETED");
    const failed = pr.checks.some((c) => c.conclusion === "FAILURE");
    const rollup =
      pr.checks.length === 0
        ? null
        : {
            state: failed ? "FAILURE" : done ? "SUCCESS" : "PENDING",
            contexts: {
              nodes: pr.checks.map((c) => ({
                __typename: "CheckRun",
                name: c.name,
                status: c.status,
                conclusion: c.conclusion,
                detailsUrl: `https://ci/${c.name}`,
              })),
            },
          };
    const decision =
      pr.reviews.at(-1)?.state === "APPROVED"
        ? "APPROVED"
        : pr.reviews.at(-1)?.state === "CHANGES_REQUESTED"
          ? "CHANGES_REQUESTED"
          : null;
    return {
      number: i.number,
      title: i.title,
      url: `https://github.com/${OWNER}/${REPO}/pull/${i.number}`,
      state: pr.merged ? "MERGED" : i.state === "closed" ? "CLOSED" : "OPEN",
      isDraft: pr.draft,
      merged: pr.merged,
      mergedAt: pr.mergedAt,
      closedAt: i.closedAt,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      body: i.body,
      headRefName: pr.head,
      baseRefName: pr.base,
      headRefOid: pr.headSha,
      mergeable: pr.mergeable,
      reviewDecision: decision,
      author: { login: i.author },
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [{ commit: { oid: pr.headSha, messageHeadline: "Change things" } }] },
      head: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
      reviewRequests: {
        nodes: (pr.requestedReviewers ?? []).map((login) => ({
          requestedReviewer: { __typename: "User", login },
        })),
      },
      reviews: {
        nodes: pr.reviews.map((r) => ({
          id: r.id,
          author: { login: r.author },
          authorAssociation: r.authorAssociation ?? "COLLABORATOR",
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
          url: null,
        })),
      },
    };
  }
}

const DEFAULT_FILES: FakePrFile[] = [
  { filename: "src/app.ts", status: "modified", additions: 3, deletions: 1 },
];

function prFiles(issue: FakeIssue): FakePrFile[] {
  return issue.pr?.files ?? DEFAULT_FILES;
}
