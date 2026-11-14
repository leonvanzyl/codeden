import {
  CreateGithubIssueRequest,
  GithubCommentRequest,
  GithubLabelRequest,
  GithubListQuery,
  MergePrRequest,
  TriageIssueRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { badRequest } from "../services/errors";
import { jsonBody, queryOf } from "./validate";

function issueNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("Issue numbers are positive integers");
  return n;
}

/** `/api/projects/:id/github/*`: synced issues and PRs, issue actions, sync now (§9). */
export function projectGithubRoutes(s: AppServices) {
  return new Hono()
    .get("/:id/github/issues", queryOf(GithubListQuery), async (c) => {
      const q = c.req.valid("query");
      return c.json(await s.github.issuesResponse(c.req.param("id"), q.state, q.limit));
    })
    .get("/:id/github/prs", queryOf(GithubListQuery), async (c) => {
      const q = c.req.valid("query");
      return c.json(await s.github.prsResponse(c.req.param("id"), q.state, q.limit));
    })
    .post("/:id/github/sync", async (c) => {
      await s.github.syncNow(c.req.param("id"));
      return c.json(s.github.sync.status(c.req.param("id")));
    })
    .post("/:id/github/issues", jsonBody(CreateGithubIssueRequest), async (c) =>
      c.json(await s.github.createIssue(c.req.param("id"), c.req.valid("json")), 201),
    )
    .get("/:id/github/issues/:number", async (c) =>
      c.json(await s.github.getIssue(c.req.param("id"), issueNumber(c.req.param("number")))),
    )
    .post("/:id/github/issues/:number/comments", jsonBody(GithubCommentRequest), async (c) =>
      c.json(
        await s.github.commentOnIssue(
          c.req.param("id"),
          issueNumber(c.req.param("number")),
          c.req.valid("json").body,
        ),
        201,
      ),
    )
    .post("/:id/github/issues/:number/labels", jsonBody(GithubLabelRequest), async (c) =>
      c.json(
        await s.github.labelIssue(
          c.req.param("id"),
          issueNumber(c.req.param("number")),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/:id/github/issues/:number/triage", jsonBody(TriageIssueRequest), async (c) =>
      c.json(
        await s.github.triageIssue(
          c.req.param("id"),
          issueNumber(c.req.param("number")),
          c.req.valid("json"),
        ),
      ),
    );
}

/** `/api/prs/:id` (`<projectId>:<number>`): details, the diff of every changed file, merge. */
export function prRoutes(s: AppServices) {
  return new Hono()
    .get("/:id", async (c) => c.json(await s.github.getPrDetails(c.req.param("id"))))
    .get("/:id/diff", async (c) => c.json(await s.github.getPrDiff(c.req.param("id"))))
    .post("/:id/merge", jsonBody(MergePrRequest), async (c) =>
      c.json(await s.github.mergePr(c.req.param("id"), c.req.valid("json"))),
    );
}

/** `/api/sessions/:id/github`: the session's issue and PR status. */
export function sessionGithubRoutes(s: AppServices) {
  return new Hono().get("/:id/github", async (c) =>
    c.json(await s.github.sessionGithub(c.req.param("id"))),
  );
}

/** `/api/github/connection`: whether GitHub is reachable (never returns the token). */
export function githubRoutes(s: AppServices) {
  return new Hono().get("/connection", async (c) => c.json(await s.github.connection()));
}
