# The software factory and the dark factory

> **Experimental.** Both factory modes are marked experimental. Try them on a sandbox repository first, set a budget and protected areas, and keep the kill switch in reach. **Assisted** remains the default for every new project.

Each project has an **autonomy mode**, a ladder you climb one step at a time. (This is separate from the per-session [permission level](security.md#permissions), which decides which actions an agent must ask about.)

| Mode | Who finds work | Who merges | You |
|---|---|---|---|
| **Manual** | You | You | Drive every session. Automations only run when you (or a PM) start them: schedules and event triggers are paused |
| **Assisted** (default) | You, the PM (triage) and automations | You | Review PRs and answer the inbox |
| **Software factory** *(experimental)* | You and the people you trust, as GitHub issues | You, or CodeDen when you turn on **auto-merge** | File issues, review the pull requests |
| **Dark factory** *(experimental)* | The software factory's sources, plus a scheduled **scout** that reviews the app against the vision | As above | Set the vision and the limits, then step away |

Change the mode from the mode picker in the project header.

## How the software factory works

Issues are created outside CodeDen: by you, a teammate, or anything that files GitHub issues. The factory takes them from there:

```
                       ┌─ Bug:      Reproduce ─► Create fix ─► Review fix ─┐
Issue ─► Identify type ┼─ Feature:  Analyze ───► Implement ──► Review ─────┼─► Merge
                       └─ Docs:     Implement docs change ─────────────────┘
                                               ▲               │
                                               └─── Revise ────┘
```

1. **Issue.** A new issue on GitHub (opened after you switched the mode on, or labelled `codeden-factory`) becomes a work item. Only issues by [trusted authors](#who-the-factory-works-for) are taken on.
2. **Identify type.** One call to the [utility model](usage-and-costs.md) classifies it as a **bug**, a **feature** or a **docs** change. A GitHub label settles it without a model call (`bug`, `enhancement`/`feature`, `documentation`/`docs`); with no model available, keywords decide. The factory labels the issue (`factory:bug`, `factory:feature`, `factory:docs`) and comments which pipeline it goes down.
3. **A free agent takes it.** The server is the orchestrator of the swarm: it hands queued items to agents as slots free up, within **Agents at once** (`maxConcurrentSessions`), once the open work waiting for an agent has one ([finish before starting](#finish-before-starting)). A fix for a failing check on the default branch goes first, then the issues you and trusted authors filed, oldest first, then the issues the [scout](#the-dark-factory) filed, by the priority it gave them. Each item gets its own agent session in its own worktree.
4. **The pipeline runs.**
   - **Bug: Reproduce.** The agent writes a failing test (or a probe) that shows the bug and reports it with `factory_report_reproduction`. A bug that doesn't reproduce stops here, with a comment on the issue asking for what's missing.
   - **Bug: Create fix.** The same agent makes the failing test pass and keeps it as a regression test.
   - **Feature: Analyze.** The agent checks whether the request already works, fits the vision and the architecture, and writes a spec with acceptance criteria (`factory_submit_analysis`). The spec is posted on the issue. A request that is already possible, unclear or out of scope stops here with a comment.
   - **Feature: Implement.** The same agent builds it to the spec, with tests and docs.
   - **Docs: Implement docs change.** No reproduction, no analysis, and no agent review as long as the change touches only documentation.
5. **Review.** An **independent reviewer session**, on a different provider from the author when one is available (or the one you pick under [Agents](#settings-and-limits)), checks the pull request against the issue, the spec and the vision. `request_changes`, or any failed merge check, sends the work back to the author: the **revise loop** (up to `maxFixAttempts` rounds, default 2). CI on the pull request's head is the authority for the full test suite. A reviewer whose own checkout can't run the tests (a broken install, timeouts under load) marks its verdict `blockers: "environment"`. That verdict never goes to the author: the reviewer gets the CI result and reviews again on the merits. If its environment stops it a second time, the item fails as an infrastructure failure, which the factory recovers by itself without using a revise round, and the next reviewer works in a clean worktree on the PR's head.
6. **Merge.** With every check green the pull request is **ready for you**: an inbox item, a comment on the PR, and the item waits at Merge until you merge it on GitHub. With **auto-merge** on, CodeDen squash-merges trusted work itself and watches CI on the default branch afterwards (a regression opens an automatic revert PR and pauses the loop).

Every pull request carries its **test results** (a `## Test results` section in the description, or the raw output attached with `attach_evidence`) and, when UI files changed, **screenshots**. Both are merge checks.

### Finish before starting

Every factory PR still open when another one merges may need a rebase and a fresh look, so the factory finishes open work before it starts more:

- **Who gets a free agent.** When an agent is free it goes, in this order, to: a reviewer for a PR whose CI passed; a rebase or conflict resolution, or a builder's revise round; a reviewer for a PR whose CI is still running; a builder carrying on after a failure outside its code, then a new build from the queue; and last the scout and its area reviewers. What waited longer goes first; the queue keeps its own order. Work in progress is never interrupted, only the next free agent is decided this way. Revise rounds and rebase requests wake an agent too, so they wait for a free one instead of going past **Agents at once**.
- **PRs open at most** (`maxOpenPrs`, by default the same as **Agents at once**). With this many factory PRs open (being checked, reviewed, revised, rebased, queued or waiting for you to merge them), no new build starts from the queue and the scout files nothing; free agents go to reviews, fixes and rebases until a PR merges or closes. A fix for a failing check on the default branch still starts, because every open PR waits on it. PRs of failed or escalated work, which wait for you, don't count (work that failed for a reason outside its code goes back by itself, so its PR does). The factory panel and the Factory view say **Finishing open work (2 of 2 PRs open)** while it holds work back, and queued items say why they wait.
- **Work that touches the same files waits its turn.** Before a queued item starts, the paths named in its issue (title, body, acceptance criteria) are compared with the files the factory's open PRs change. An item that clearly overlaps one ("Deferred: likely overlaps open PR #12 (src/counter.ts)") goes behind items that don't, and still starts when nothing else is waiting.

### The pipeline on the dashboard

The project page shows the factory panel with the pipelines drawn as a live diagram. Every work item sits on the node of its current step, and **clicking it opens the agent session working on it** (or the item, before an agent has it). A dashed chip is waiting for a free agent; a circular arrow marks work in a revise round; a shield marks work let in from an untrusted author.

![The factory panel with the live pipeline diagram](images/factory-panel.png)

Under the diagram: spend against the daily budget, agents working out of the limit, pull requests ready for you (or merges today with auto-merge), the failure streak, merge checks per PR, recent results, and the issues ignored because of their author.

The loop runs its regular check every 30 seconds: it moves work in progress, picks up new issues, starts free agents and, in a dark factory, starts the scout if it's due. **Check now** on the panel runs that check immediately. In a dark factory, **Run scout now** starts a [scout round](#the-dark-factory) right away.

### The Factory view

While the factory runs you mostly just want to glance at it. The **Factory view** is a calm, full-screen page for that, made to stay open on a second screen. It shows only the factory: no sidebar, no sessions list, no side panels. The factory panel stays where it is, for settings, limits and details.

Open it with **Factory view** on the project page or the factory panel, or **Factory view · <project>** in the command palette (Ctrl K). It has its own address, `/projects/<projectId>/factory/view`, so you can bookmark it. **Full screen** in its header fills the screen (in the desktop app, F11 does the same), and **Exit** goes back to the project page. It's only offered for projects in software factory or dark factory mode.

- **The header** shows the project, its mode and the loop state (with the reason when it's paused, or "stopped" when a kill switch is on). Two counters answer "is anything waiting on me?": how many items **need you** and how many **failed**. The kill switch, **Check now** and **Run scout now** work here as on the panel.
- **The figures**, in one row: spend today against the daily budget, merges today (against the daily cap when auto-merge is on), agents working against the limit, the factory's open pull requests, failures and reverts today, and the median time from issue to merge over the last 7 days (from when the factory took the issue in). Where the panel shows the same figure, it's the same number.
- **The pipeline**, left to right: **Intake** (new issues before their type is known, and in a dark factory the scout's round and its area reviewers), **Identify type** (sorted into bug, feature or docs, waiting for a free agent), **Building** (reproduce or analyze, then implement), **Reviewing** (the independent review, the merge checks and CI), **Merge queue** (in the order they merge, each pull request with its state and place, such as "Updating · #1" or "Queued #2", plus the ones rebasing, rebuilding, waiting for you or stuck) and **Merged** (today's merges).
  - **Cards.** Each item is a card with its issue number and title, its type, what it's doing now (its agent's latest progress line), and how long it's been in its step. It also shows its pull request's state and, while it's reviewed or queued, how many merge checks passed (for example 5/8).
  - **Markers.** Every card has one of four markers: running, waiting (nobody needs to act, as for a merge that's done), needs a person, or failed.
  - **Live.** Cards move as the factory works, with no reload.
- **Needs you** is a lane above the pipeline for escalated work, and for failures from the last day or older ones whose pull request is still open. However much newer history there is, an old escalation or failure stays there until it's settled; this includes a rebuild that failed while the factory still owns its original pull request. On wide screens the lane takes at most about a third of the height and scrolls, so the pipeline stays in view. A stuck pull request stays in the merge queue, outlined in amber like anything else waiting on a person (a pull request for you to merge, an agent's question). Failed cards are outlined in red.
- **Click a card** to see its details in a side sheet without leaving the view: the steps of its pipeline with the current one marked (also "waiting for a free agent" and "watching CI on the default branch"), the issue and the pull request, the merge checks, the review, and links to the builder's and reviewer's sessions.
- **The PM chat** shows the last three turns with the project's PM and its usual message box. Replies stream in as in any session, and **Open full chat** opens the PM's page. On screens 1280 pixels wide and up it sits beside the pipeline, and **Hide** folds it into a slim bar. Narrower, it opens from that bar as a side sheet.

On tablets and phones the stages stack as sections you can fold, the figures wrap, and the PM chat opens from a button as a sheet from the bottom. Each stage is a labelled region and each card a button named after its number, title and state. A screen reader hears cards move politely ("#142 moved to Reviewing"), and with reduced motion on, cards don't animate.

#### Pixel mode

**Pixel mode** in the header swaps the figures and the pipeline for a small pixel-art factory floor, seen from above, that works along with the factory. It's just for fun and off by default. The board stays the full view, and your browser remembers which one you picked.

- New and sorted issues are a pile of tickets at the **IN** door. When a build starts, a worker carries a ticket to a bench.
- Each build has a worker at a workbench, hammering while its agent works, with a "?" when the agent asks you something. Each review has a worker with a clipboard inspecting a crate.
- The merge queue is a row of crates on the conveyor to the **SHIP** door, in merge order, flagged when one waits on you. A merge sends a crate out with a sparkle. Today's merges stack on the dock.
- Failed and escalated work sits on broken machines along the bottom: a red lamp and smoke for a failure, an amber lamp for an escalation, and a flag above each.
- In a dark factory, the scout walks the floor with a magnifying glass during a round, and its area reviewers write on notepads in the corner.
- On the wall, a gauge shows spend against the daily budget, and a counter board shows today's merges.
- With the kill switch on or the loop stopped, the lights dim and everyone sits down.

Hover a worker, ticket, crate or machine to see its issue number and title (a builder also shows its latest progress line). Click it to open the same side sheet as on the board. Workers, crates and machines can also be reached with Tab. Under the scene, a line says what it shows ("4 building, 1 in review, 3 merged today, 2 need you") and updates for screen readers.

The scene is one small canvas drawn about 12 times a second. It stops drawing while the tab is hidden, and with reduced motion on it shows a still frame that changes only when the factory does. Pixel mode isn't offered on phones (narrower than 640 pixels), where the scene would be too small to tap; they always show the board.

### Finished work cleans up after itself

Once a work item is finished (merged, reverted, rejected or failed), the factory [archives](workbench.md#archiving-and-worktree-cleanup) its sessions: the builder and its reviewers leave the sidebar and their worktrees are removed, so a busy factory fills neither your session list nor your disk. Nothing is lost. The branch, the checkpoints and the transcript stay, archived sessions are under the project's **Archived** filter, clicking the item on the panel still opens its session, and messaging an archived session brings it back with its worktree. A worktree with uncommitted changes is kept, as with any archive.

Work that isn't finished keeps its sessions: a pull request escalated to you, a merge whose CI on the default branch is still being watched, and an item that failed only on the size limit while its pull request is open (the PM may still allow it). A session still finishing a turn is never cut off; it is archived once the turn ends. After a **Retry** that starts over (**Rebuild**, or a retry without an open pull request), the earlier attempt's sessions are archived the same way, unless they were archived already. Its pull request (and any the factory still had to close) is closed with a link once the new attempt's pull request is open; until then the panel lists it as superseded. A retry that re-reviews the open pull request keeps the builder (a revise round needs it) and lets the earlier reviewer go. The factory archives an item's sessions only once, so a session you unarchive stays, even through a retry. The scout and its area reviewers are long-lived and never archived this way.

## Who the factory works for

On a public repository anyone can open an issue, and an issue is a prompt for a coding agent. So the factory only takes on issues by **trusted authors**:

- the GitHub account CodeDen uses (the one `gh` is signed in as), always;
- the logins you list in **Trusted authors** in the factory settings.

Everyone else's issues are **ignored**: listed under *Ignored · untrusted authors* on the panel, with no model call, no agent and no comment on them. Labels don't count as trust (issue templates can apply labels for anyone). If you add the author to your trusted list later, their open issues are taken on.

To take on one of them anyway, click **Let in** on the panel or the item page, or ask the PM to (`factory_admit_issue`; the PM is told to do this only when you ask, never because an issue or a comment asks). Work let in that way runs through its pipeline like any other, **but it is never merged automatically**, whatever the auto-merge setting says: a person merges it.

Other guards:

- The factory never merges, reviews or acts on pull requests other people open. It only merges pull requests its own agents opened for its work items.
- Issue text and comments reach agents as data, with instructions to ignore anything in them that asks for secrets, CI or deploy changes, unknown hosts, or work outside the repository.
- Only evidence comments posted by the account CodeDen uses count as test output or screenshots.

## The dark factory

A dark factory adds a **scout**: a long-lived agent that finds the work itself, so you can step back.

When fewer than **Review when fewer than** (`minBacklog`, default 2) items wait to be classified or for an agent, and **Every (hours)** (`discoveryIntervalMin`, default 6 hours) has passed since its last round, the scout runs a **review round**. A threshold of 0 turns scheduled rounds off. **Run scout now** on the factory panel starts a round at any time, skipping the interval and the threshold:

1. **Plan.** The scout looks at the app against the vision (what changed since its last round, what is open) and asks for at most **Review areas per round** (`discoveryPerRound`, default 2) review areas with `factory_plan_round`, each with a focus specific to this app.
2. **Review.** Each review area gets an **area reviewer**: a long-lived reviewer agent focused on one area of the app (UI and UX, performance, security, features, bugs, code quality, test gaps or docs). Each reports findings with `factory_report_findings`.
3. **File.** The scout decides against the vision what is worth doing, merges duplicates, and files at most **Issues per round** (`maxIssuesPerRound`, default 3) as GitHub issues with `factory_file_issue`, already typed. They enter the pipelines like any trusted issue.

The rules that keep it cheap are enforced by the server, not left to the agents:

- **One scout and at most one area reviewer per review area, ever.** They are long-lived: the next round sends them a message instead of starting new sessions, so they keep what they learned and don't re-read the codebase.
- **At most `discoveryPerRound` review areas per round**, however many the scout asks for, and only as many as there are free agent slots: reviews, fixes, rebases and builds waiting for an agent come first. The scout ends its turn once it has planned, so its own slot goes to an area reviewer. When an area gets no reviewer, `factory_plan_round` tells the scout why (not an allowed area, asked for twice, over the round's limit, or no free slot under **Agents at once**).
- **A scheduled round only starts when the queue runs low** and the interval has passed; at most `maxIssuesPerRound` issues come out of it; a round that runs over three hours is closed.
- **No round and no filing at the work-in-progress limit** ([PRs open at most](#finish-before-starting)). A round already running keeps its area reviewers' findings and files them once a PR has merged; a round without area reviewers reviews then. The time a round waits doesn't count against its three hours.
- **Run scout now** skips the interval and the threshold, nothing else. It's disabled, with the reason in its tooltip, while a round is running, when no agent slot is free (or other work waits for the free ones), at the work-in-progress limit, while the loop is paused or over today's budget, or while a kill switch is on. The next scheduled round counts its interval from the end of the manual one.
- The scout and its area reviewers hold agent slots and count against the daily budget like every other factory session.

### Nobody waits on you in a dark factory

In a dark factory, the project's PM and the factory's own sessions (the scout, its area reviewers, builders, reviewers) never stop to ask you something. A question, through CodeDen's `ask_user` or the agent's own question tool, gets an immediate answer instead: decide from the vision and carry on. An **approval** (a risky action under its permission level) is **denied** at once, never approved, with the same guidance.

- **The vision wins over the current code.** Work that brings the code in line with the vision comes first.
- **Decisions are recorded.** Each judgement call goes through `factory_record_decision` to your inbox as a low-priority **Factory decided** message and into the daily digest.
- **Flagged decisions:** a protected area, a missing or self-contradicting vision, or anything irreversible outside the code is flagged as **Factory needs you**, at high priority, without stopping the rest.
- **Quiet by default.** The factory's own activity (its decisions, the PRs it reviews and merges, its sessions' failures, the digest) lands in the inbox without a toast. Flagged decisions, PRs a person has to merge, a paused loop and a regression still notify you. Turn **Factory activity** on under **Settings → Notifications** to see everything (see [the inbox](orchestration.md#the-inbox)).

Sessions you start yourself still ask you as usual, and so does the PM when you talk to it. In the software factory, questions reach you, since exceptions are yours to handle.

## Before you switch a factory on

CodeDen refuses to switch until all three are in place:

1. **A GitHub project.** The factory works through issues, pull requests and checks.
2. **A vision file**, `.codeden/VISION.md`, edited in the UI (**Vision** on the project page).
3. **A daily budget**, in USD or tokens (or both).

Strongly recommended as well:

- **CI on pull requests.** By default a repository without CI fails the CI check (`requireCi`).
- **Branch protection** on your default branch that requires those checks.
- **An audit command** (for example `pnpm audit --prod`) for the security check.
- **Protected areas** for anything you never want changed without you.
- **Auto-merge off** until you trust what the factory ships.

## The vision file

Agents get the vision in their prompts, the analyzer checks feature requests against it, and the scout finds work with it. It's plain Markdown: `##` headings are sections, bullets under them are the entries. Unknown sections are ignored.

```markdown
# Vision

A tiny, dependable arithmetic library for scripts.

## Goals
- Cover the common numeric helpers people reach for in scripts
- Zero runtime dependencies

## Target users
- Script authors who want small, obvious helpers

## Principles
- Small, well-tested changes
- Keep the public API stable

## Out of scope
- Big-number or arbitrary-precision maths
- A CLI

## Quality bar
- Every behaviour change comes with tests
- CI is green before merge

## Protected areas
- `**/auth/**`
- `**/migrations/**`
- `.github/workflows/**`
- `LICENSE`
- payments
- licensing
```

Recognised sections: **Goals**, **Target users** (or Users, Audience), **Principles** (or Values), **Out of scope** (or Non-goals), **Quality bar** and **Protected areas**. If the file is missing, the editor starts from a template like the one above.

![The vision editor with the parsed sections and protected areas](images/vision-editor.png)

### Protected areas

Anything here **always comes to you**: a pull request that touches it is escalated (**Needs you**) and never merged automatically.

- **Paths:** anything in backticks is a glob (`` `**/auth/**` ``, `` `LICENSE` ``). Bare entries that look like paths (contain `/` or `*`, or look like a file name) are treated as globs too.
- **Topics:** plain words such as `payments` or `licensing`. A topic is matched as a word in the PR title and description, and well-known topics also protect their usual paths:

| Topic | Also protects |
|---|---|
| `auth`, `authentication` | `**/auth/**`, `**/*auth*.*` |
| `payments`, `billing` | `**/payment*/**`, `**/billing/**`, `**/*payment*.*`, `**/*billing*.*` |
| `migrations`, `data migrations` | `**/migrations/**`, `**/*migration*.*` |
| `infrastructure`, `infra` | `**/infra/**`, `**/terraform/**`, `**/*.tf`, `.github/workflows/**` |
| `licensing`, `license` | `LICENSE`, `LICENSE.*`, `COPYING` |

You can add more globs in the factory settings (**Protected paths**), on top of the vision's. The vision file itself and deploy files are always protected (see below).

## Merge checks

Every check must pass before a pull request is ready to merge. Results are recorded per item and shown on the panel and the item page.

| Check | Passes when |
|---|---|
| **Protected areas** | No changed path matches a protected glob, the vision file or a deploy file, and no protected topic is mentioned. A failure escalates the PR to you |
| **Size** | The change is within **Largest change** (`maxChangedLines`, default 5,000 added + deleted lines) and **Most files changed** (`maxChangedFiles`, no limit by default). Lockfiles and generated or vendored files don't count. The PM can allow a bigger change that can't be split |
| **CI** | The PR's checks are green. While the PR has merge conflicts it waits for them to be rebased away (GitHub runs no CI on a conflicting PR). No checks on the head commit wait 10 minutes from when that head appeared, then count as "CI never started" (see [below](#failures-outside-the-work)), unless `requireCi` is off |
| **Review** | The independent reviewer approves against the issue, the spec and the vision. Skipped for docs-only changes in the docs pipeline |
| **Tests** | Test files changed (or the change is only docs or config), and the reviewer agrees the tests the change needs exist |
| **Test results** | The PR description has a `## Test results` section, or test output was attached with `attach_evidence`. Skipped when no code changed |
| **Security** | Your `auditCommand`, run in the builder's worktree, passes, and the reviewer raised no security concerns |
| **Screenshots** | If UI files changed, screenshots were attached with `attach_evidence` |

A failed check (other than size) starts a **revise round**: the builder gets the failures and fixes them in the same branch, up to `maxFixAttempts` rounds; after that the item fails and counts towards the pause limit. A builder session that died is resumed by the revise message. CI that never started is no code problem, so it never starts a revise round (see [Failures outside the work](#failures-outside-the-work)). A review verdict that arrives after a revise round started goes to the builder as part of that round; one that arrives after the item failed is kept on the item.

**Too large is different.** A revise round can't make work smaller without cutting scope, so a size failure skips it and doesn't count towards the pause limit. Instead the PM is woken to split the work into smaller issues, or, when it can't be split (an initial scaffold, a stack migration), allow it with `factory_allow_large_change`.

## The factory looks after its pull requests

Merging is mechanical, so the server loop does it on every check, not an agent and not the PM. An agent only gets involved when a merge conflict needs judgement. The **Pull requests** card on the factory panel shows where each PR stands: the merge queue first, in the order it merges (numbered), then every other PR the factory owns, then today's merges. Each has a state: **Checking**, **Waiting for CI**, **Queued**, **Updating**, **Rebasing**, **Rebuilding**, **Superseded** (a newer PR for the same work replaced it, and the factory closes it), **Waiting for you**, **Stuck** or **Merged**.

**Every factory PR is owned until it merges or closes**, whatever its item's stage. A PR that waits for a person (auto-merge off, a protected area, an untrusted author, checks that failed after the revise rounds) is still read every few minutes and kept free of merge conflicts, so you never open a factory PR that rotted into conflicts. When you merge or close it on GitHub, its item is done. The factory never merges an escalated PR (a protected area) itself, and a failed item's PR merges only after it is reviewed again (see [Stopped work with an open pull request](#stopped-work-with-an-open-pull-request)).

**The merge queue.** With auto-merge on, a PR whose checks all pass doesn't merge on the spot: it joins the queue. The factory merges one PR at a time, oldest approved first (a revert goes ahead of everything), and at most one per check.
- Only the PR at the head of the queue acts, so CI doesn't run on every queued PR at once. The others wait their turn.
- When the head is behind the default branch, GitHub brings it up to date (**Update branch**, with the head commit pinned): no agent is needed. CI then runs on the new head, and the PR merges once it passes. Merging the default branch in like this needs no new review.
- The daily merge limit and a paused loop hold the queue, as before. A revert may still merge while the loop is paused.

**Merge conflicts are the factory's own job.** When another merge leaves a PR conflicting with the default branch, its builder is asked to rebase onto it and resolve the conflicts. That isn't a revise round.
- If cleanup archived the builder meanwhile, the request brings it and its worktree back, and the factory archives it again once its turn is over. When the builder's session is gone, a fresh **integrator** session takes the PR over. It works on the PR's own branch and is briefed with the issue, the PR description and the review history. If it opens a new PR instead, the item follows the new PR, whatever its stage, and the old one is closed with a link.
- The agent is asked again while the conflicts remain, up to three times. CI is then awaited on the rebased head. If the reviewer had approved already, it re-checks only the conflict resolution (`git range-diff` of the old head against the new one); its approval stands if the resolution is right. When the reviewer's session is gone, a fresh reviewer does the same re-check, told what was approved.
- The audit (`auditCommand`) only runs in the builder's worktree once it is there again and the builder is between turns. Until then the audit is pending, and it is still required before a merge.

**Rebuild instead of fail.** A PR that still conflicts after three requests to rebase is usually cheaper to redo than to rescue. The same item goes back to the queue with its reproduction or spec, and a fresh builder redoes the work from the latest default branch. Once the new PR is open, the old one is closed with a link to it; if GitHub refuses, the factory tries again on every check until it is closed, even after the new PR merged. An item gets one rebuild.

### Stopped work with an open pull request

An item that used up its revise rounds keeps its pull request, and that pull request often moves on afterwards: its builder resolves merge conflicts, or fixes a finding after the last review. The verdict it stopped on then no longer covers the pull request, so the factory doesn't leave it there.
- **It is re-reviewed by itself.** The factory records the head commit each review verdict covers. When a failed item's pull request is open and mergeable, has a newer head than its last verdict, and CI on that head is green, the pull request goes back to a fresh review: no new build, the same pull request. Approved with every check green, it merges as usual (or is ready for you, with auto-merge off). A request for changes gets one more revise round. This happens once per new head and at most three times per item, and never while the factory is paused. While CI on the new head is still running, the item says it is re-reviewed once CI passes.
- **The review sees every commit.** It runs in a fresh session in a clean worktree on the pull request's head, so a stale checkout can't repeat an old verdict.
- **What it needs is on the item.** A failed item whose pull request isn't re-reviewed by itself (red CI on its head, no new commits since its last review, or its three automatic re-reviews used) says "Stopped after N revise rounds; needs a re-review (Retry)". "Waiting for a person to merge it" is reserved for escalated work, which only you merge.
- **Retry resumes the pull request.** **Retry** on a stopped item whose pull request is still open sends that pull request straight back to a fresh review with fresh revise rounds. It doesn't redo the reproduction or analysis and doesn't open a second pull request. **Rebuild** starts over from the first step, and the old pull request is closed with a link once the new one is open. Without an open pull request, Retry rebuilds. Retry is on the item page and beside stopped items in the factory panel's **Recent** column.
- **The PM can do it too.** `factory_retry_item` takes the item and an optional mode, `rereview` (the default while its pull request is open) or `rebuild`. The PM retries trusted work on its own. Work you let in from an untrusted author is retried only when you ask for it, as with letting it in.

Not covered: a pull request the reviewer rejected (the change shouldn't exist), one that only failed the size limit (the PM decides that), and stuck items (they are in your inbox).

### Failures outside the work

An item that failed for a reason outside its code goes back by itself on the next check after the cause is gone: to verification when its PR is open (the PR is picked up again, not redone), otherwise to building, with a message to the builder to carry on. These failures never count towards pausing the loop, and an item is put back at most three times. They are:
- the builder or reviewer session died: an error, a runner restart, a message that raced a running turn. It goes back once the runner offers that provider again;
- the builder session is gone: a fresh builder picks the work up, or an integrator looks after its open PR;
- CI never started on the head commit although GitHub Actions are on. The factory starts it again: it updates the branch when the PR is behind the default branch, otherwise the builder pushes an empty commit. When the builder's session is gone, an integrator takes the PR over to push it, once an agent is free. CI isn't timed out until that happened.

What the item still owes comes back with it. If the reviewer hadn't re-checked a conflict resolution yet, a fresh reviewer does, and the earlier approval doesn't count until that re-check approves.

Items that failed this way before this was added are recognised by their reason and recovered too.

### Only what is truly stuck reaches you

Three things go to your inbox and to the project manager, because the factory can't settle them by itself:
- an item whose PR still conflicts after its one rebuild;
- a protected area;
- CI that can never run: GitHub Actions turned off, or no active workflow. Turn them on and retry the item, or turn off **Require CI**.

In a dark factory each one arrives as a [recorded decision](#nobody-waits-on-you-in-a-dark-factory) flagged for you, so the daily digest lists it. Nothing waits silently on a PR.

## Settings and limits

Settings are **enforced by the server**, never left to agent judgement. Open them with **Settings** on the factory panel.

| Setting | Default | Effect |
|---|---|---|
| Merge automatically (`autoMerge`) | off | Off: every PR waits for you. On: trusted work merges once every check passes. Work let in from an untrusted author always waits |
| Trusted authors (`trustedAuthors`) | none | GitHub logins whose issues are taken on, besides the account CodeDen uses |
| Daily budget (USD and/or tokens) | required | The loop pauses until the next day when today's spend reaches it |
| Agents at once (`maxConcurrentSessions`) | 2 | The swarm: builders, reviewers, the scout and its area reviewers share it; reviews, fixes and rebases get a free agent first |
| Auto-merges per day (`maxMergesPerDay`) | 5 | With auto-merge on, also caps the builds in flight |
| Pause after failures (`pauseAfterConsecutiveFailures`) | 3 | Failed merge checks or reverts in a row pause the loop |
| Protected paths | none | Added to the vision's protected areas |
| Allow deploy and release changes (`allowDeploys`) | off | While off, deploy files (`.github/workflows/*deploy*`, `*release*`, `*publish*`, `Dockerfile`, `fly.toml`, `vercel.json`, `netlify.toml`) are protected |

**Tuning.** **PRs open at most**, the **Merge checks**, **Agents** and (in a dark factory) **The scout** sections of the settings cover every knob below except `areas` and `idleGraceMin`, which are set through the API's `tuning` field. Saving changes only the knobs you send; the rest keep their saved values.

| Setting | In the settings | Default |
|---|---|---|
| `maxOpenPrs` | PRs open at most (the [work-in-progress limit](#finish-before-starting); empty: the same as Agents at once) | `null` (Agents at once) |
| `maxChangedLines` / `maxChangedFiles` | Merge checks: Largest change (lines) / Most files changed | `5000` / no limit (`null` turns either off) |
| `maxFixAttempts` | Merge checks: Revise rounds (after a review asking for changes or a failed check; then the item fails) | `2` |
| `watchTimeoutMin` | Merge checks: Watch main CI (minutes) (after an automatic merge; a failure while watched reverts it) | `120` |
| `requireCi` | Merge checks: Require CI | `true` |
| `auditCommand` | Merge checks: Audit command | none |
| `minBacklog` | The scout: Review when fewer than (issues waiting; `0` turns scheduled rounds off) | `2` |
| `discoveryIntervalMin` | The scout: Every (hours) | `360` (minutes) |
| `discoveryPerRound` | The scout: Review areas per round | `2` |
| `maxIssuesPerRound` | The scout: Issues per round | `3` |
| `builderProvider` / `builderModel` | Agents: Builder provider / Builder model | `auto` (**Automatic**: the project's provider, else the agent role's) / `null` (the provider's default) |
| `reviewerProvider` / `reviewerModel` | Agents: Reviewer provider / Reviewer model | `auto` (**Automatic**: a different provider from the builder's) / `null` (the provider's default) |
| `reviewerFallback` | Agents: When the reviewer's provider is unavailable | `builder` |
| `areas` (dark factory: the review areas the scout may use) | API only | all eight |
| `idleGraceMin` (minutes a builder or reviewer may stay idle after its last turn, once reminded of its step, before the item or review fails) | API only | `10` |

**Agents.** This section picks who builds and who reviews. A reviewer on a different provider from the builder gives the most independent review, which is what **Automatic** does. A model applies only to a provider you chose; with **Automatic**, each provider uses its default model. Changing a provider resets its model to **Provider default**.

New builders and reviewers start only on an **available** provider: installed, signed in and not at its usage limit. The pickers mark the ones that aren't, and say what happens until they are:

- **A builder** whose provider is unavailable starts on another available provider (the project's, then the agent role's, then any), with that provider's default model.
- **A reviewer** whose provider is unavailable (or fails to start) follows **When the reviewer's provider is unavailable** (`reviewerFallback`):
  - **Review on the builder's provider and model** (`builder`, the default), in a fresh session;
  - **Review on any available provider** (`any`);
  - **Wait until it is available again** (`wait`).
- **No provider available at all:** the build or review waits, whatever the setting, and the item says until when ("Waiting: no review provider available until …").

The item's page notes when a review didn't run where the settings asked, and why.

Spend comes from the same ledger as the [usage reports](usage-and-costs.md).

## The kill switch

- **Per project:** **Kill switch** on the factory panel.
- **Global:** **Settings → General → Global factory kill switch** stops every project's loop.

One click stops the loop and **every factory session** (builders, reviewers, the scout, its area reviewers); items that were building go back to the queue. The loop stays stopped until you turn the switch off. A kill switch never hands work back to automations.

When the loop **pauses** by itself (budget, repeated failures, a revert), resume it from the panel once you've looked at the reason; that also clears the failure count.

## How the factory and automations share work

In both factory modes the loop is the only intake for issues. Automations triggered by new or labelled issues that would triage or start a session are recorded as skipped (`factory_intake`), so an issue is never taken on twice. Scheduled automations (security audit, dependency updates, ...) keep running alongside the loop, and their PRs are reviewed by you as usual. In Manual and Assisted the loop is idle.

## Warnings

- **Auto-merge merges to your default branch.** Merge checks reduce risk; they don't remove it. Use branch protection and real CI, and start with auto-merge off.
- **It spends real money or quota.** Set a daily budget you're comfortable losing on a bad day; subscription users spend their plan's limits.
- **Agents can be wrong in confident ways.** The reproduction, the analysis, the independent reviewer and tests help, but read the daily digest and spot-check what ships.
- **Protected areas are your safety net.** Put auth, payments, data migrations, infrastructure and licensing there.
- **Keep your trusted-author list short.** Everyone on it can make the factory spend your budget.

## API

Everything in the UI is also available over the local API (with the install token as a bearer token):

| Route | |
|---|---|
| `GET /api/projects/:id/factory` | Panel status (items with their pipeline step and how long they've been in it, ignored issues, the scout, and for the Factory view: its figures in `stats`, in `viewRecent` the escalations, open or recent failures and today's merges that the capped `recent` list can leave out, and each item's `ownedPr`) |
| `PUT /api/projects/:id/autonomy` | `{ mode, limits?, tuning? }` (`mode`: `software_factory` or `dark_factory`; the old `autopilot` still reads as `software_factory`) |
| `GET` / `PUT /api/projects/:id/vision` | Read or write the vision |
| `POST /api/projects/:id/factory/admit` | `{ itemId, type? }`: let an ignored issue in |
| `POST /api/projects/:id/factory/set-type` | `{ itemId, type, reason? }`: move an item that hasn't started to another pipeline |
| `POST /api/projects/:id/factory/items/:itemId/retry` | `{ mode? }`: run a stopped item again. `rereview` (the default while its pull request is open) sends that pull request back to a fresh review; `rebuild` (the default without one) starts over from the first step. `409 no_open_pr` for a re-review without an open pull request |
| `POST /api/projects/:id/kill-switch`, `POST /api/factory/kill-switch` | `{ on: true }` |
| `POST /api/projects/:id/factory/resume` | Clear a pause |
| `POST /api/projects/:id/factory/tick` | Run the regular check now (**Check now**) |
| `POST /api/projects/:id/factory/scout` | Dark factory: start a scout round now (**Run scout now**); `409 scout_unavailable` with the reason when it can't |
| `POST /api/projects/:id/factory/digest` | Today's digest now |

For example, to switch a project to the software factory with auto-merge on and one teammate trusted:

```sh
TOKEN=$(cat ~/.codeden/install-token)
curl -X PUT http://127.0.0.1:4317/api/projects/<projectId>/autonomy \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"mode":"software_factory","limits":{"dailyBudget":{"usd":10},"autoMerge":true,"trustedAuthors":["my-teammate"]}}'
```
