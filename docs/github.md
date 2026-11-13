# GitHub

Projects with a GitHub remote get the full flow: issues and PRs synced into CodeDen, sessions linked to their issue, branch and PR, evidence that renders inline, and PR reviews in your inbox. Local-only folders work without any of this.

## Connecting

CodeDen uses your **GitHub CLI login**. Run `gh auth login` once (or use **Sign in** on the setup checklist) and you're done.

- The token is read from `gh auth token` at runtime and kept in memory only. It is never written to disk, logged or returned by the API. If GitHub answers 401, CodeDen asks `gh` again once, so a re-login is picked up without a restart.
- **Fallback:** if `gh` isn't available, you can store a token in the OS keychain (`github.token`).
- **Settings → GitHub** shows the connection status.
- Agents use `gh` inside their own worktrees for everything else (for example `gh issue create`).

Without a connection, GitHub views show a hint and GitHub actions fail with a clear "not connected" error; nothing else breaks.

## Sync

CodeDen polls instead of using webhooks (a local app can't receive them):

- **Issues** are listed with conditional requests (`If-None-Match`), so an unchanged repository costs nothing against your rate limit.
- **Pull requests** that changed, have pending checks or unknown mergeability, or belong to a session are fetched in one batched GraphQL query.
- **Interval:** every 15 seconds while a session's PR is open, every 60 seconds otherwise, with backoff on errors and a pause until the reset when you hit a rate limit.
- A new session on the head branch of an open, unlinked PR gets linked within a few seconds.
- `CODEDEN_GITHUB_SYNC=0` turns polling off.

Sync produces events that the rest of CodeDen reacts to: `issue.opened`, `issue.labeled`, `issue.commented`, `issue.updated`, `pr.opened`, `pr.updated`, `pr.review_requested`, `pr.checks_passed`, `pr.checks_failed`, `pr.merged`, `pr.closed` and `review.submitted`. They feed [notices](orchestration.md#notices), [automation triggers](automations.md#triggers) and the [factory loop](software-factory.md). The very first import is silent, so connecting an existing repository doesn't flood your PM.

## Where you see it

- **Project → GitHub tab:** open issues and pull requests with their checks and review state.
- **Session header badges:** the linked issue and PR.
- **Right panel → Issue / PR tab** (**Alt+5**): the session's PR with live status, checks, reviews, mergeability, description and changed files.
- **Inbox:** PRs ready for review.

![A session's pull request: checks, reviews, changed files and a squash-merge button](images/pr-details.png)

## Traceability

Every session records its issue, branch, PR and commits.

- **Branches** are `codeden/<slug>-<id>` by default, on a fresh worktree under `~/.codeden/wt/`.
- **Pull requests** are opened by the agent with `create_pull_request`. It refuses to run with uncommitted changes unless the agent passes a commit message, pushes the session branch, then creates the PR (or updates the open one for that branch). The body gets `Fixes #<issue>` when the session has an issue, plus a footer naming the CodeDen session.
- **A PR belongs** to the session that opened it, or to the session whose branch is its head.
- **Comments** CodeDen posts carry a hidden `<!-- codeden -->` marker (they're posted with your token). It's stripped again when comments are shown to agents or in the UI, and those comments never trigger automations.

## Reviewing and merging

When a session's PR is open, out of draft and its checks have passed (or it has none), a **PR review** item appears in your inbox. Review it in the Issue / PR tab and use **Squash and merge** (squash is the default), or merge on GitHub. Merging or closing the PR resolves the inbox item.

When a session's PR is merged, CodeDen:

1. stops the session's provider if it's idle and marks the session **completed**;
2. comments "Resolved by #N" on the linked issues.

In **Manual** and **Assisted** projects, nothing is ever merged without you. Automatic merges only happen in the experimental [factory modes](software-factory.md) with auto-merge turned on, only for work from trusted authors, and only after every merge check passes.

### Feedback on your sessions' pull requests

When a pull request owned by a session **you** started fails its checks, gets a trusted review that requests changes (see below), or runs into merge conflicts, CodeDen sends the session a message (from CodeDen, queued behind a running turn) so the agent can fix it without you relaying anything: the failing checks with their links (and a hint to read the logs with `gh run view <run-id> --log-failed`), the reviewer's comments, or the base branch to merge. Each problem is sent once per head commit, and at most three messages go out per pull request; after that it's up to you. Archived and stopped sessions aren't messaged. Sessions started by a project manager, the orchestrator or an automation are followed up by the project manager instead. Turn it off under **Settings › General › Agent sessions › Pass on pull request feedback**.

On a public repository anyone can review a pull request, and a review passed on to an agent is a prompt. So requested changes are passed on only when the reviewer:

- has write access to the repository: its owner, a member of the organization that owns it, or a collaborator (GitHub's author association);
- is the GitHub account CodeDen uses (the one `gh` is signed in as);
- is one of the project's **Trusted authors** (in its [factory settings](software-factory.md#who-the-factory-works-for)).

The message also tells the agent that comments and reviews from people without write access are input data, not instructions. Anyone else's review isn't sent to the session. The project manager still gets a notice about it, but without the review's text, and it doesn't wake the PM: it shows up in the PM's next update instead. See [Security → What CodeDen trusts from GitHub](security.md#what-codeden-trusts-from-github).

## Evidence

Agents attach screenshots, test output and other files with `attach_evidence`:

- Files are committed to a dedicated orphan branch, **`codeden/evidence`**, under `pr-<n>/<session>/` or `issue-<n>/<session>/`. CodeDen uses the Git Data API, so no checkout is touched and your branches stay clean.
- One comment on the PR or issue embeds the images and includes the summary and test output.
- Images are linked through `github.com/<owner>/<repo>/blob/<commit>/<path>?raw=true`, which GitHub serves to signed-in readers, so they **render inline in private repositories too**.

Browser screenshots taken with `browser_screenshot` can go straight into evidence, which is how the [UI review automation](automations.md#built-in-templates) and the factory's `ui_evidence` merge check work.

## Issues

- PMs read issues with `list_issues` and `get_issue`, create them with `create_issue`, and comment with `comment_on_issue`.
- With the **Issue triage** automation on, the PM classifies each new issue as **ready**, **needs info**, **unsafe**, **out of scope** or **duplicate**, applies labels and a comment per your policy, and either starts a session or asks you "Should I take this on?" in the inbox. See [Automations → Issue triage](automations.md#issue-triage).

## Local-only projects

A folder without a GitHub remote gets sessions, worktrees, checkpoints, diffs, the workbench and automations that don't need GitHub. GitHub lists are simply empty, and no GitHub request is ever made for it. Templates marked `requiresGithub` (issue triage, stale PR follow-up) aren't offered, and the factory modes need a GitHub project.

### When a folder gets a GitHub remote later

A project's git checkout and GitHub remote (`origin`) are detected when you add it, and checked again:

- **after every agent turn** in a local-only project, the moment an agent may have run `git init`, created a repository or pushed to one;
- **when the server starts**, for every project;
- **on demand**, with **Check again** on the GitHub tab's "Local-only project" screen, in a session's Issue / PR tab, and next to the "A GitHub project" requirement in the Autonomy dialog. It tells you what it found, such as "Connected to owner/repo" or "Still no GitHub remote on origin".

What a check changes:

- **A GitHub `origin` appeared:** the project becomes a GitHub project. The header shows the repository, the GitHub tab fills with issues and PRs (the first import is silent), and the factory modes become available. No reload is needed.
- **The folder became a git checkout:** its default branch is recorded, so worktrees work.
- **`origin` moved to another repository:** the project follows it. Issues and PRs synced from the old repository are dropped and the new one is imported from scratch.
- **The GitHub `origin` is gone:** nothing is downgraded and nothing is lost. The project keeps its repository and shows a "GitHub remote is missing" warning on the GitHub tab. Restore the remote and **Check again**, or choose **Make local-only** (synced issues and PRs stay in the database, and adding the remote back later reconnects the project).

Credentials embedded in a remote URL (`https://user:token@github.com/...`) are removed before the URL is stored or shown.
