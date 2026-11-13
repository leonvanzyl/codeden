# Orchestration

CodeDen runs three kinds of agent: one **orchestrator**, one **project manager (PM)** per project, and any number of **agent sessions**. They're all ordinary agent sessions on Claude Code, Codex, OpenCode or Cursor; what differs is their role, system prompt, working directory and tools.

| Role | How many | Works in | Can edit code? | Purpose |
|---|---|---|---|---|
| Orchestrator | 1 | `~/.codeden/orchestrator/` | No | Your front door: creates and configures projects, routes requests to PMs, summarises status across projects |
| Project manager | 1 per project | The project root, read-only | No | Triages issues, plans work, starts and steers agent sessions, reviews results, escalates to you |
| Agent | Many | Its own worktree and branch | Yes | Does the work: code, tests, PRs, evidence |

The orchestrator and PMs run **read-only**: Claude gets no edit tools and a policy that denies writing commands, Codex gets a read-only sandbox, and CodeDen's policy refuses OpenCode's and Cursor's edits and writing commands (Cursor also runs in its read-only `ask` mode). They act only through CodeDen's tools. Choose the provider, model and effort for each role in **Settings → Providers** (Claude Code is the default for the orchestrator and PMs when it's available).

![A PM reporting on its project](images/pm-chat.png)

## How work flows

1. **Work arrives.** You ask the orchestrator or a PM, you start a session yourself, a PM picks up a GitHub issue, or an automation fires.
2. **A session starts.** The PM (or you) names a provider, model, brief and optionally an issue. CodeDen creates the worktree and branch and starts the session in the runner.
3. **The agent works.** It may ask questions or request approvals (both land in your inbox), share screenshots, report progress, and finally open a PR with evidence linked to the issue.
4. **Notices wake the PM.** Session and GitHub events become typed notices, batched into an "updates since your last turn" summary.
5. **The PM decides.** It follows up with the agent, reports to the orchestrator, or asks you. It never merges on its own; automatic merges only happen in the [factory modes](software-factory.md).
6. **The orchestrator wakes only for what matters.** PMs can mark messages as informational so routine updates don't wake it.

## Talking to them

- **Orchestrator:** pinned at the top of the sidebar (**Alt+O**). Try "What's going on across my projects?", "Create a project for C:\code\api", or "Ask the storefront PM to look at issue 12".
- **PM:** under each project in the sidebar, or **Talk to the PM** on the project page.

Both chats show the role badge, the model, the running cost and a **Read-only** marker in the header.

![The orchestrator summarising running work, items waiting on you and recent finishes](images/orchestrator.png)

## Status digests

Every time the orchestrator or a PM wakes (you message it, a notice arrives, another role asks it something), CodeDen prepends a fresh, compact status block to its input, so it knows the current state without spending a tool call:

- **PM digest:** running and queued sessions (work key, purpose, status, last progress, age), the next scheduled automation runs, open inbox items, and recent finishes and failures.
- **Orchestrator digest:** the same, rolled up per project.

Undelivered notices follow as an "Updates since your last turn" list. Each block is wrapped in its own tags, `<codeden_status>…</codeden_status>` and then `<codeden_updates>…</codeden_updates>`, and everything after them is what you (or the waking role) actually wrote. The tags matter because a notice can quote a multi-paragraph message. If free text in a block contains one of these tag names, it is defused, so only CodeDen's own tags open and close a block.

In the transcript both blocks fold into a **Status sent to agent** marker you can expand, and the message bubble shows only your own text.

## Notices

Notices are structured records, not text to be parsed back. They render as cards in the PM and orchestrator chats.

| Notice | When |
|---|---|
| `session.finished`, `session.needs_input`, `session.failed` | A session ended its work, is waiting on you, or failed |
| `pr.opened`, `pr.checks_passed`, `pr.checks_failed`, `pr.merged` | GitHub sync saw a PR change |
| `review.submitted` | A review was submitted on a PR |
| `issue.opened` | A new issue arrived |
| `automation.skipped` | A scheduled run was skipped (overlap, quiet hours, daily cap, ...) |
| `conflict` | A start request matched running work |
| `pm.message` | A PM messaged the orchestrator |
| `factory.update` | Factory events: work ready to merge, failures, escalations, regressions, or the daily digest |

**Wake-ups are rate limited.** Notices about work started by a PM, the orchestrator or an automation wake the PM after a 5-second debounce (30 seconds at most), and each role is woken at most 6 times per 10 minutes. New issues always wake the PM; PRs that don't belong to a session wake it only for openings and reviews.

## Work keys and conflicts

Every session and automation run records **what** it is, so CodeDen can stop duplicate work before it starts:

| Field | Example |
|---|---|
| `startedBy` | you, the orchestrator, a PM or an automation (with its id) |
| `purpose` | "Write the v0.2 release notes" |
| `workKey` | `issue:142`, `pr:57`, `automation:security-audit`, `request:write-the-v0-2-release-notes` |
| `scope` | the project, optionally narrowed to paths (`src/auth`) or an area (`ui`) |
| progress | the agent's last `report_progress` line |

If you don't give a work key, CodeDen derives one: `issue:<n>` when an issue is linked, otherwise `request:<slug of the purpose>`. You can set one from the **⋯** button at the top of a **New session**, before you send its first message.

**Conflict check.** Starting a session, running an automation or a scheduled trigger first looks for running or queued work in the same project with the **same work key**, or the **same kind** of work (the part before the colon) with an **overlapping scope** (the same area, or paths where one contains the other). Work scoped to the whole project never counts as overlapping.

When there's a match, nothing starts. Instead the caller gets the existing work's details and four choices:

| Choice | Effect |
|---|---|
| **Wait** | Queue behind the existing work |
| **Skip** | Don't start anything |
| **Join** | Send the request to the existing session as a follow-up |
| **Force** | Start anyway; the reason is recorded |

A PM chooses for itself (join when the request adds to the running work, wait when it has to follow it, skip when it's the same work) and tells you in one line what it chose. A conflict from something you started appears as a card in place and in the inbox, and you choose. Example: you ask the orchestrator for a security audit; it asks the PM, which sees `automation:security-audit` already running, skips the duplicate and replies with the audit's progress. Nothing is duplicated.

## Now / Next

Each project page shows a **Now / Next** strip: what's running and the upcoming scheduled automation runs. From there you can skip the next run of a schedule. PMs can do the same with `skip_next_run`, for example when an audit you started by hand will still be going at the scheduled time.

## Tools by role

Agents see only the tools for their role; everything else isn't listed at all. The core and situational-awareness tools are always loaded; the rest sit behind tool search so they don't fill the context window.

| Role | Tools |
|---|---|
| Orchestrator | `get_overview`, `list_projects`, `create_project`, `update_project`, `message_pm`, `ask_pm`, `list_inbox`, `schedule_wakeup`, `list_wakeups`, `cancel_wakeup` |
| PM: sessions and status | `get_project_status`, `list_sessions`, `get_session`, `start_session`, `message_session`, `stop_session`, `answer_question` |
| PM: automations | `list_automations`, `run_automation`, `list_scheduled_runs`, `skip_next_run`, `pause_automation`, `resume_automation`, `cancel_queued_run` |
| PM: issues and PRs | `list_issues`, `get_issue`, `triage_issue`, `create_issue`, `report_triage`, `comment_on_issue`, `get_pr_status` |
| PM: other | `message_orchestrator`, `read_project_notes`, `update_project_notes` (`.codeden/notes.md`), `ask_user`, `schedule_wakeup`, `list_wakeups`, `cancel_wakeup` |
| Agent | `report_progress`, `ask_user`, `share_to_chat`, `suggest_followups`, `finish`, `create_pull_request`, `attach_evidence`, `comment_on_issue`, `get_pr_status`, the `browser_*` tools |
| Everyone | `generate_image` (when an image engine is available) |

Factory projects add a few more (see [The software factory and the dark factory](software-factory.md)).

### Asking and answering

- **Defaults first.** Agents, PMs and the orchestrator decide routine details themselves (naming, approach, scope, provider and model), say what they assumed so you can override it, and keep going. They ask you only for destructive or irreversible steps, spending money or credentials, outward-facing actions (publishing, releases, deploys, messages to people), protected areas, or a request that can be read two very different ways.
- **Commits and pull requests.** An agent in its own worktree commits as it goes without asking. It opens a pull request by itself when a PM or an automation started it; in a session you started, it opens one when you ask and otherwise offers it as a suggested follow-up. An agent working in your checkout instead of a worktree doesn't commit unless you ask.
- **`ask_pm`** (orchestrator → PM) waits up to 3 minutes for the PM's answer; a later answer arrives as a message.
- **`message_orchestrator`** with `informational: true` never wakes the orchestrator; it shows in its next digest.
- **`ask_user`** (agent or PM → you) puts a question card in the transcript and the inbox. The tool waits up to 4 minutes; if you haven't answered, the agent is told to finish what it can, and your later answer is sent to the session as a new message. This works the same on every provider.
- **`answer_question`** (PM → agent): a question from work the PM, the orchestrator or an automation started wakes the PM first. When the brief, its notes or the vision settle it, the PM answers it; the agent carries on and the inbox item closes as answered by the PM. Approvals, and questions from sessions you started, always wait for you.
- **`schedule_wakeup`** (orchestrator or PM → itself): wake me in N minutes, or at a time up to 7 days ahead, with a note. When it's due, CodeDen wakes them with the note and the usual status digest, so they can check on work or try again later without you prompting them. Wake-ups survive restarts; `list_wakeups` and `cancel_wakeup` manage them (at most 20 pending each).
- **`start_session` with `reportTo: "orchestrator"`** (PM): for work the orchestrator passed on. When the session finishes (calls `finish`) or fails, the orchestrator is woken with the result too, so it can tell you.

## The inbox

The inbox collects everything waiting on you:

| Kind | Examples |
|---|---|
| Question | An agent or PM used `ask_user` |
| Approval | A risky action under the default autonomy level |
| PR review | A session's PR is out of draft and its checks passed |
| Failed run | A session or automation run failed |
| Triage | "Should I take this on?" for a triaged issue |
| Conflict | A start request that matched running work |
| Automation result | Results flagged for attention, the factory digest, budget alerts |
| Message | A message addressed to you |

Each item links to its session, issue and PR, and can be answered in place. The sidebar shows the count, and the **Waiting on you** box lists the top items. Toasts are on by default; browser notifications are opt-in in **Settings → Notifications**.

Not everything that lands in the inbox needs you, so CodeDen tags each item and only some kinds raise a toast or a notification. **Settings → Notifications → Notify me about** has four switches:

| Category | What it covers | Default |
|---|---|---|
| Needs you | PRs only a person can merge (auto-merge off, an untrusted author, a protected area), factory decisions flagged `needsHuman`, start conflicts, budget alerts | On |
| Failures | Failed runs of sessions you or a PM started, a paused factory loop, a regression after a merge, a worktree that couldn't be removed | On |
| Factory activity | What the factory handles itself: its decisions, the PRs it reviews and merges, its own sessions' failures, stopped items, the daily digest | Off |
| Automations | Automation results and triage decisions | On |

Switched-off categories still land in the inbox (and the factory's in the daily digest). Several updates within a few seconds become one toast ("4 updates from the factory"), and at most three toasts are on screen at once. A toast says what happened in one line, and **Open** goes to the thing itself: a failed run opens its session, anything else opens the inbox scrolled to that item (or conflict). Browser and system notifications follow the same rules: a burst is one notification that updates in place.

Approvals and questions block an agent until you answer, so they also play a short chime (turn it off with **Sound when an agent needs you**), keep a toast on screen until you open or resolve them, put an amber dot on the tab icon, and make a background tab's title alternate with "⏳ Waiting on you".

![The inbox](images/inbox.png)
