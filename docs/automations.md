# Automations

Automations are background work you switch on per project: a weekly security audit, dependency updates, issue triage, a nightly UI review. Each one says **when it runs**, **what it does** (usually: start an agent session with a prompt), **which agent** runs it and **with what permissions**, plus a few guards. Every run is an ordinary session (or PM turn) with a full transcript, so background work stays visible.

**Everything starts off.** New, imported and PM-created automations, and the starter set a new project gets, are all off until you switch them on.

![A project's automations with their schedules, last runs and the next occurrences](images/automations.png)

## Where to find them

- **Sidebar → project → Automations** lists each automation with its switch, **Run**, the next occurrence and its last run.
- The **Automations** page has three tabs: **Automations**, **Runs** (history with status and skip reasons) and **Templates** (the built-in and global templates, and the starter set). Its header has **New automation**, **Import** and **Export all**.
- The project's **Now / Next** strip shows the upcoming runs, where you can skip the next one.
- **Settings → General → Automations** is the master switch for all of them.

An automation runs only when **all** of these are on: the master switch, the project's automations switch, and the automation's own switch. Automations that target all projects can also be switched on or off per project.

## Create an automation

Press **New automation**. One editor holds everything, and everything in it can be changed later on the automation's page:

1. **Name and description**, and where it **runs in**: this project, or all projects.
2. **When it runs**:
   - **On a schedule**: every few minutes or hours, daily, on weekdays, weekly on a day, or monthly on a date, each at a time you pick, or **Custom (cron)** for anything else. The editor says it in plain English ("Every weekday at 09:00") and lists the next three runs. Pick a **timezone**, or leave it empty for the project's.
   - **When something happens**: a pull request is opened, merged or its checks fail, a review is requested, an issue is opened, labelled or commented on, or a session finishes, fails or waits on you. Issue and PR events can be narrowed by labels, branches and authors.
   - **Only when I run it**: it runs when you press **Run now**, or when the PM runs it.
3. **What it does**: start an agent session (the usual choice), message the PM, or triage an issue. Write the **prompt** in the roomy editor; **Insert placeholder** adds fields such as `{{project.name}}`, `{{date}}` or, for event triggers, `{{pr.number}}` and `{{issue.title}}` at the cursor.
4. **Agent**: the provider, model and reasoning effort, in the same picker as the composer. Leave it on the default agent to follow your settings.
5. **Permissions**: what the agent may do on its own while nobody is watching.

   | Permissions | What it means |
   |---|---|
   | **Read-only** | Can read and run checks, but never edits files, commits or pushes |
   | **Supervised** | Asks before edits and commands |
   | **Auto** | Works freely in its worktree and asks only for risky actions |
   | **Full** | Never asks |

   Read-only suits audits and reports; Full is for work you trust to run unattended. See [Security](security.md#permissions) for how each level is enforced.
6. **Advanced options** (collapsed): the session title, the [work key](#work-keys), what happens when matching work is still running, concurrency, a daily maximum, quiet hours and catching up missed runs. See [Guards](#guards).

Choose **Starts off** or **Starts on** in the header, then **Save**, or **Save and run now** to try it straight away.

**From a template.** On the Templates tab, **Use template** opens the same editor filled in from a built-in or global template, to adjust before saving. **Add and enable** adds it as it is.

**From a session.** Did something once by hand that worked ("audit the auth routes", "update the dependencies and open a PR")? Choose **Make an automation…** in the session's **⋯** menu, or **Make an automation from this session…** in the command palette (**Ctrl K**) while the session is open. The same editor opens for the session's project, filled in from the session: its opening message as the prompt (attachments are left out), its provider, model, effort and permissions, and its title as the name and session title. It runs **only when you run it** until you pick a schedule or an event. Nothing is saved until you press **Save**, and like every new automation it starts off.

**Later.** The automation's page is the same editor plus its schedule, **Run now**, pause and skip, and recent runs. **Duplicate** makes an editable copy (off), **Export** shares it, and the bin icon deletes it (its past runs and sessions stay).

**Files are read-only here.** Automations defined in a `.md` file (see [The file format](#the-file-format)) show a **From file** badge and are edited in the file; **Duplicate to edit** makes a copy you can change in CodeDen.

**From the PM.** Ask your PM ("run the linter every night and tell me what fails") and it can create the automation with `create_automation`, or change one with `update_automation`, using the same validation. PM-created automations start off and say **Created by the PM**, so you can check the prompt and permissions before switching them on.

## Sharing: export and import

Automations travel as Markdown files with YAML frontmatter, the same format as automation files, so a shared file also works dropped into a repo's `.codeden/automations/` folder.

- **Export** on an automation's page: **Download .md** (`<name>.md`) or **Copy as Markdown**.
- **Export all** on the Automations page downloads every automation of the project as a `.zip` of `.md` files.
- **Import** takes one or more `.md` files, a `.zip` of them, or pasted Markdown. CodeDen parses each file exactly like an automation file and shows a preview: name, schedule, agent, permissions, the first lines of the prompt, and any error (bad YAML, an unknown field, an invalid cron expression or timezone, a missing prompt). Pick which ones to import and whether they go into this project or all projects.

Imported automations always start **off**, and an import never runs anything. A file with **Full** permissions is flagged in the preview, so you can read its prompt before switching it on. Unknown frontmatter fields are refused on import (a typo such as `maxPerDya` would otherwise be silently ignored). An import takes at most 50 files of up to 128 KB each (1 MB in total), and a zip of up to 1 MB.

## Built-in templates

| Template | Trigger | What it does | Starter | Needs GitHub |
|---|---|---|---|---|
| **Security audit** | Mondays 03:00 | Reviews code, config and dependencies for vulnerabilities, leaked secrets and unsafe patterns; fixes small issues in one PR and files one issue per confirmed finding | yes | |
| **Dependency updates** | Tuesdays 05:00 | Applies patch and minor updates that pass the tests in one PR; majors and breakages become issues | yes | |
| **UI review** | Wednesdays 06:00 | Walks the running app in the session browser at desktop and narrow widths, checks layout, accessibility and console errors, files issues with screenshots and fixes small defects | | |
| **Test coverage gaps** | Thursdays 04:00 | Finds untested high-risk code, adds focused tests for the top gaps in one PR, files issues for the rest | yes | |
| **Refactor sweep** | 1st and 15th, 04:00 | One small, behaviour-preserving cleanup of a hotspot, delivered as a focused PR | | |
| **Stale PR follow-up** | Weekdays 08:00 | Finds PRs idle for 5+ days; rebases and fixes CodeDen's own PRs, nudges people politely on theirs, never merges | yes | yes |
| **Issue triage** | When an issue opens | The PM classifies the issue, labels and comments per policy, then starts a session or asks you | yes | yes |

The templates are ordinary Markdown files (shipped in the package under `templates/automations/`); open one with **Use template**, or export it, to see how a good prompt is structured.

## Triggers

In files, the editor's choices are stored as one of three trigger types. Schedules are always stored as a cron expression, so "Every weekday at 09:00" is `0 9 * * 1-5`.

| Trigger | Frontmatter | Notes |
|---|---|---|
| **Cron** | `type: cron`, `expression`, optional `timezone` | Standard cron syntax. Occurrences are computed in the trigger's IANA timezone, else the project's, else the machine's |
| **Event** | `type: event`, `event`, optional `filter` | See the event list below |
| **Manual** | `type: manual` | Runs only when you (or a PM) start it |

In a project in **Manual** [autonomy mode](software-factory.md), scheduled and event automations don't fire on their own (the Now / Next strip is empty); you can still run any automation by hand.

**Events:**

| Event | Fires when | Placeholders available |
|---|---|---|
| `issue.opened` | A new issue appears in sync | `issue.*` |
| `issue.labeled` | Labels are added to an issue (`filter.labels` matches the labels just added) | `issue.*` |
| `issue.commented` | Someone comments on an issue (CodeDen's own comments never trigger) | `issue.*`, `comment.*` |
| `pr.opened` | A PR is opened | `pr.*` |
| `pr.review_requested` | Reviewers are newly requested on a PR | `pr.*` (including `pr.reviewers`) |
| `pr.merged` | A PR is merged | `pr.*` |
| `pr.checks_failed` | A PR's checks fail | `pr.*` (including `pr.failedChecks`) |
| `session.finished` | A session in the project finished its work | `session.*` |
| `session.failed` | A session failed | `session.*` |
| `session.needs_input` | A session is waiting on you | `session.*` |

`filter` narrows an event trigger: `labels` (the issue's labels; any match, case-insensitive), `branches` (the PR's or session's head branch, exact match) and `authors` (GitHub logins; for `issue.commented`, the comment's author). An automation never triggers on a session it started itself.

## Actions

| Action | What happens | The Markdown body is |
|---|---|---|
| `start_session` (default) | Starts an agent session in a new worktree with the prompt, optional `title`, `provider`, `model`, `effort` and `autonomy` (the permissions) | the prompt |
| `message_pm` | Sends a message to the project's PM | the message |
| `triage` | Hands an issue to the PM to triage with a `policy` | extra triage guidance |

## Guards

Guards are checked in this order every time a trigger fires:

1. **Quiet hours** (`quietHours: { start: "22:00", end: "07:00", timezone? }`) and **daily cap** (`maxPerDay`, counted per local day). Manual runs skip these.
2. **Overlap with running work.** The run's [work key](orchestration.md#work-keys-and-conflicts) is checked against running and queued work. `overlapPolicy` decides what happens on a match:
   - `skip-if-running` (default): record a skipped run and notify the PM.
   - `queue`: queue the session behind the existing work.
   - `run-anyway`: start anyway, with the reason recorded.

   Manual runs get the usual **wait / skip / join / force** choice instead.
3. **Concurrency** (`maxConcurrent`, default 1): queued and running runs of this automation in the project.

`catchUpMissed: true` runs a missed occurrence once after downtime or sleep (an occurrence more than 2 minutes late counts as missed); otherwise missed occurrences are dropped.

## Runs

**Approvals nobody answers.** A session started by an automation, a PM or the factory that asks for an approval (a risky action under its permission level) waits 30 minutes for you, then gets a denial telling it to find another way or report what it needed, so a run finishes instead of blocking the next ones. Nothing is ever approved on your behalf. Sessions you start yourself wait for you as long as it takes.

Every outcome is recorded as a run: `queued`, `running`, `completed`, `failed`, `skipped` or `cancelled`. Skipped runs carry a reason: `overlap`, `concurrency`, `quiet_hours`, `daily_cap`, `disabled`, `skipped_by_pm`, `conflict_skip` or `factory_intake`. Session runs follow their session, and link to it both ways. Skipped runs send an `automation.skipped` notice to the PM, which may take over or adjust the schedule.

PMs manage automations with `list_automations`, `create_automation` and `update_automation` (created off; files stay read-only), `run_automation`, `list_scheduled_runs`, `skip_next_run`, `pause_automation` / `resume_automation` (no cron or event runs while paused) and `cancel_queued_run`.

## The file format

Every automation can be written as a Markdown file with YAML frontmatter: it is what **Export** produces and **Import** reads, and you can keep automations as files in your repository instead of in CodeDen. Put a file in one of:

| Location | Applies to | Id |
|---|---|---|
| `~/.codeden/automations/<name>.md` | All projects (also listed as a template) | `global:<name>` |
| `<repo>/.codeden/automations/<name>.md` | That project (commit it to share it with your team, or don't) | `project:<projectId>:<name>` |

CodeDen watches both folders (and rescans every 60 seconds), so saving the file is enough; **Reload files** on the Automations page re-reads them immediately. Files that fail to parse are listed with their error. File automations are edited in the file; in the UI you can switch them on and off, run them, export them and **Duplicate to edit**. The enabled switch survives edits. New file automations start **off**.

### A complete example

`.codeden/automations/release-notes.md`:

```markdown
---
name: Release notes draft
description: Drafts release notes from the pull requests merged this week, every Friday afternoon.
trigger:
  type: cron
  expression: "0 16 * * 5"
  timezone: Europe/London
action: start_session
workKey: automation:release-notes
title: Release notes draft
provider: claude
effort: medium
autonomy: auto
guards:
  overlapPolicy: skip-if-running
  maxPerDay: 1
  quietHours:
    start: "22:00"
    end: "07:00"
  catchUpMissed: true
---
You are drafting the weekly **release notes** for {{project.name}} ({{date}}).

## 1. Collect
- List the pull requests merged since last Friday:
  `gh pr list --state merged --search "merged:>=<the date 7 days ago, YYYY-MM-DD>" --json number,title,author,labels,url`
- Skip PRs labelled `skip-changelog` and pure dependency bumps.
- Call `report_progress` with the number of PRs found.

## 2. Write
- Group the changes under **Added**, **Changed**, **Fixed** and **Security**, one line each,
  written for users, not developers. Link every line to its PR.
- Prepend the draft to `CHANGELOG.md` under an `## Unreleased` heading. Don't touch older entries.

## 3. Deliver
- Open a pull request with `create_pull_request` titled `docs: release notes draft ({{date}})`.
- If nothing was merged this week, don't open a PR.

Call `finish` with the PR link, or say that there was nothing to release.
```

An event-driven one, `.codeden/automations/ci-fix.md`, that tries to fix failing checks on CodeDen's own branches:

```markdown
---
name: Fix failing CI
description: When checks fail on a CodeDen branch, try a minimal fix.
trigger:
  type: event
  event: pr.checks_failed
action: start_session
workKey: "automation:ci-fix:{{pr.number}}"
title: "Fix CI on #{{pr.number}}"
autonomy: auto
guards:
  overlapPolicy: skip-if-running
  maxConcurrent: 2
  maxPerDay: 6
---
Checks failed on PR #{{pr.number}} ({{pr.title}}, branch `{{pr.branch}}` into `{{pr.base}}`):
{{pr.failedChecks}}

Check out the branch with `gh pr checkout {{pr.number}}`, read the failing logs with
`gh run view --log-failed`, make the smallest fix that turns them green, run the tests and push.
Comment on the PR with `comment_on_issue` describing what you changed. If the failure is not
caused by this PR, say so in a comment and stop. Never merge.
```

Tip: quote any value that starts with `{{`, as in the `workKey` above, so YAML doesn't read it as a map.

### Frontmatter reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Shown in the UI |
| `description` | string | | One line for the list |
| `trigger` | object | required | `cron`, `event` or `manual` (see [Triggers](#triggers)) |
| `action` | `start_session` \| `message_pm` \| `triage` | `start_session` | |
| `workKey` | string | `automation:<file name>` | `<kind>:<id>`; may use placeholders |
| `title` | string | | Session title; may use placeholders |
| `provider` | string | the agent role default | `claude`, `codex` |
| `model` | string | the provider default | |
| `effort` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | | Each model supports a subset |
| `autonomy` | `read_only` \| `supervised` \| `auto` \| `full` | your default | The permissions; see [Security](security.md#permissions) |
| `guards.overlapPolicy` | `skip-if-running` \| `queue` \| `run-anyway` | `skip-if-running` | |
| `guards.maxConcurrent` | integer | `1` | Per project |
| `guards.maxPerDay` | integer or null | null (no cap) | Per local day |
| `guards.quietHours` | `{ start, end, timezone? }` or null | null | `HH:MM`, 24-hour |
| `guards.catchUpMissed` | boolean | `false` | |
| `policy` | object | | `triage` only, see below |
| `starter` | boolean | `false` | Offer it in the starter set (global templates) |
| `requiresGithub` | boolean | `false` | Hide it from local-only projects |

### Placeholders

Prompts, messages, titles and work keys can use:

| Placeholder | Value |
|---|---|
| `{{project.name}}`, `{{date}}`, `{{time}}` | Always available |
| `{{issue.number}}`, `{{issue.title}}`, `{{issue.url}}`, `{{issue.author}}`, `{{issue.labels}}`, `{{issue.body}}` | Issue events |
| `{{comment.author}}`, `{{comment.body}}`, `{{comment.url}}` | `issue.commented` |
| `{{pr.number}}`, `{{pr.title}}`, `{{pr.url}}`, `{{pr.branch}}`, `{{pr.base}}`, `{{pr.failedChecks}}`, `{{pr.reviewers}}` | PR events |
| `{{session.id}}`, `{{session.purpose}}`, `{{session.workKey}}`, `{{session.summary}}`, `{{session.outcome}}` | Session events |

### Tips for good automation prompts

- State the goal and the definition of done in the first paragraph.
- Tell the agent to call `report_progress` at each phase and `finish` at the end, so the run is easy to follow.
- Say what to do when there's nothing to do (don't open an empty PR).
- Keep the PR small and say what goes into an issue instead.
- Use a work key that matches what the work *is*, so a manual run and a scheduled one can't collide.
- Give it the least permissions that do the job: **Read-only** for audits and reports that only open issues or comment.

### Work keys

A run's work key (`<kind>:<id>`, default `automation:<file name>`) says what the work is. Runs with the same key count as the same work, so the overlap guard can skip or queue a run while matching work (from this automation, another one, or a session you started) is still going. See [orchestration](orchestration.md#work-keys-and-conflicts).

## Issue triage

With the **Issue triage** automation on (GitHub projects only), each new issue goes to the PM with your triage policy. The PM reads it (`get_issue`, `list_issues` for duplicates), applies the decision with `triage_issue` and reports it with `report_triage`:

| Decision | Default labels |
|---|---|
| ready | `triage:ready` |
| needs info | `needs-info` |
| unsafe | `triage:unsafe` |
| out of scope | `out-of-scope` |
| duplicate | `duplicate` |

Then:

- a **ready** issue starts a session (work key `issue:<n>`) if `autoStart` is on and the project isn't in Manual mode;
- otherwise you get a **"Should I take this on?"** inbox item to accept (a session starts) or decline.

The `policy` block in the frontmatter controls this:

```yaml
policy:
  labels:
    ready: [triage:ready]
    needs_info: [needs-info]
  comment: true          # post a short comment explaining the decision
  closeRejected: false   # close duplicates and out-of-scope issues as "not planned"
  autoStart: false       # start sessions for ready issues without asking
  provider: codex        # optional: provider, model and autonomy for sessions it starts
```

A triage run stays **running** until the PM reports its decision, and fails if no report arrives within 30 minutes.

## Automations and the factory

In **Software factory** and **Dark factory** projects the [factory loop](software-factory.md) owns issue intake. Automations triggered by `issue.opened` or `issue.labeled` whose action is `triage` or `start_session` are recorded as skipped (`factory_intake`) instead, so an issue is never taken on twice. Scheduled automations, `message_pm` automations and manual runs keep working alongside the loop.
