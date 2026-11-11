# Changelog

All notable changes to CodeDen are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Plan mode.** Turn on **Plan** in the new session dialog or in the composer (next to Permissions) and the agent explores and proposes a plan before it changes anything. The plan arrives as a card: **Approve plan** and the agent carries on and implements it with the session's permissions, or **Keep planning** with a note on what to change and it revises the plan. While planning, file edits and writing commands are refused at every permission level (the agent's own plan file excepted). Plan mode is offered for agent sessions on providers that support it (Claude Code today); turning it off without approving returns the session to its permission level.

### Security

- **Read-only commands are checked more strictly.** Sessions at Read-only, the orchestrator, PMs and agents in plan mode may no longer use the options that make a reading program write or run something (`sort -o`, `uniq` with an output file, `find -fprint`/`-ok`, also after `--`, `fd -x`, `rg --pre`, `less -o`, `tree -o`, `date -s`, `file -C`, `git diff --output`, `git grep -O`), git's writing forms (`git branch <name>`, `git tag <name>`, `git remote remove`, `git worktree remove`, `git reflog expire`, abbreviated `git config` writes), `gh` verbs that aren't reads or `gh` extensions, background jobs (`&`), nor unquoted parentheses and braces, in which PowerShell runs code even after an allowed cmdlet. Options are read the way the shell passes them (`-'o'` is `-o`), and variables, `$'…'` quoting and unquoted patterns that could become an option are refused.

### Changed

- **Plainer words in the factory.** The dark factory's scout no longer talks about "lenses": it uses **review areas** (security, UI & UX, performance, docs and so on), each with an **area reviewer**, a long-lived reviewer agent focused on that one area. The setting is now **Review areas per round**, and the scout's prompts and docs use the same words. Existing dark factories keep their reviewer sessions; nothing to migrate.
- **The factory explains itself.** On the pipeline diagram, each step's name (Identify type, Reproduce, Analyze, Implement, Review, Checks, Merge) is underlined and opens a short explanation of what happens there and what moves the work on. A "?" explains each lane (Bug, Feature, Documentation) and the revise loop. The scout, its rounds and review areas, and the factory settings that aren't self-explanatory (auto-merges per day, pause after failures, the scout's schedule and limits) have the same hints. They open on hover, on keyboard focus, or with a tap on a phone.

## [0.6.0] - 2026-11-11

Maintenance release.

## [0.5.0] - 2026-11-10

### Added

- **The software factory.** File GitHub issues (you, or people you trust) and the factory runs them through a pipeline: each issue is classified as a **bug**, a **feature** or a **docs** change, then a pool of agents takes it. A bug is reproduced with a failing test before it is fixed, a feature is analyzed against the vision (with a spec posted on the issue) before it is built, a docs change goes straight to the edit; an independent reviewer then checks bugs and features and sends them back for a revision when needed. Every pull request carries its test results, and screenshots for UI changes. Set how many agents may work at once in the factory settings.
- **The pipelines, live on the project page.** The factory panel draws the pipelines (Issue, Identify type, the Bug, Feature and Docs lanes, Merge) with every issue on the step it's at. Click an issue to open the agent session working on it.
- **Trusted authors.** On a public repository anyone can open an issue, so the factory only takes on issues by the account CodeDen uses on GitHub and the logins you list under **Trusted authors**. Everyone else's are listed as ignored, untouched, until you click **Let in**; work let in that way is never merged automatically.
- **The dark factory's scout.** A dark factory now has a scheduled scout: one long-lived agent that, when the queue runs low, reviews the app against the vision with a few long-lived reviewer agents (lenses for UI, performance, security, features, bugs, code quality, tests and docs) and files the work worth doing as issues. Lenses per round and issues per round are capped, and the scout and its lenses reuse their sessions round after round instead of starting new ones.
- **Retry, change the pipeline, or let an issue in** from a factory item's page.

- **A real browser in the desktop app.** The browser panel now shows the session's browser as a native browser view instead of a streamed picture: native scrolling, text selection, typing with your input method, a right-click menu, full frame rate, and **⋯ › Inspect** for DevTools. Agents keep driving the same tabs, and the **Agent is acting** chip still shows when they do. Each session has its own cookies and storage. A phone or a plain browser tab watching the same session sees it streamed, as before. Browsers opened from a plain browser tab or a phone keep using the streamed view.
- **Quitting the desktop app keeps your session browsers.** Each open tab moves to CodeDen's background browser at the same address, with its cookies, so agents can carry on. Anything you typed into a page and didn't save is lost. When you open the app again, those sessions stay on the streamed view; browsers you open from then on are native again.
- **Settings › App › Native browser** turns native views on or off (on by default). Off brings back the streamed view for browsers opened from then on.
- **Downloads from the session browser** in the desktop app go to your Downloads folder (never overwriting a file), with a notification when they finish.
- **Refresh models.** A refresh button at the bottom of the model picker's provider rail asks the shown provider for its models again (on Favourites, every provider), for when a new model is out and the list hasn't caught up yet.
- **The PM answers its agents' questions.** When a session the PM, the orchestrator or an automation started asks a question, the PM is woken first and can answer it with its new `answer_question` tool when the brief, its notes or the vision settle it. The agent carries on straight away, and the inbox item closes, marked **Answered by the project manager** in the transcript. Approvals, and questions from sessions you started yourself, still wait for you.
- **Work you hand the orchestrator reports back.** When the PM starts a session for a request the orchestrator passed on, it can mark it to report to the orchestrator (`start_session` with `reportTo: "orchestrator"`). When that session finishes (calls `finish`) or fails, the orchestrator is woken with the result as well as the PM, so it can tell you instead of waiting for you to ask.
- **The orchestrator and PMs can set themselves a wake-up.** With `schedule_wakeup` they ask to be woken in a number of minutes or at a time (up to 7 days ahead) with a note, so they can check on work or retry later on their own instead of saying "message me later". Wake-ups survive restarts and show as a **Wake-up** card when they fire; `list_wakeups` and `cancel_wakeup` manage them.
- **The PM can read what a session said.** Its new `get_session` tool returns a session's last message in full, the questions and approvals it's waiting on (with their inbox ids) and its result, so the PM can act on a question an agent ended its turn with. PM tools that take a session id also accept the short id shown in updates and the status digest.
- **Agents hear about their pull requests.** When the pull request of a session you started fails CI, gets a review requesting changes, or runs into merge conflicts, CodeDen now tells the agent (the failing checks with links, the review, or the branch to merge) so it can fix it without you passing it on. Once per commit and at most three times per pull request; switch it off under **Settings › General › Agent sessions**. Work started by a project manager or an automation is still followed up by the project manager.
- **Sessions recover from passing failures by themselves.** When an agent's turn fails because the API was overloaded, the connection dropped or the agent CLI exited, CodeDen continues the session after 20 seconds, 90 seconds and 5 minutes (giving up after three tries in a row); when a usage limit was hit, it continues a minute after the limit resets. The transcript says when it will try, nothing lands in your inbox in the meantime, and sending a message or pressing Stop cancels it. Switch it off under **Settings › General › Agent sessions › Retry after passing failures**.
- **Claude Fable 5.2 is priced** in usage reports ($8 / $40 per million input / output tokens), and so is the `fable` alias.

### Changed

- **Autopilot is now the Software factory, and you merge.** Factory pull requests now stop at **Ready to merge** (an inbox item and a comment on the PR) until you merge them on GitHub. Turn on **Merge automatically** in the factory settings to let CodeDen merge trusted work once every check passes, as before. Projects on Autopilot become software factories with auto-merge off; their issues from authors you haven't trusted are no longer taken on.
- **Factory issues are classified, not triaged.** The project manager no longer scores each new issue; the factory classifies it and queues it straight away. The PM can still move an item to another pipeline, or let an ignored issue in when you ask it to.
- **A new merge check: test results.** A pull request that changes code needs a `## Test results` section or test output attached as evidence. Revise rounds default to two.

- **The browser panel is a real browser surface.** The page now fills the panel edge to edge and is laid out at the panel's own size, instead of a fixed 1280×800 page shrunk into a small card. It re-flows as you resize the panel, and it's sharp on HiDPI screens (rendered at your screen's pixel ratio, up to 2×). Pick a fixed device size under **⋯ › Viewport** if you want one; **Fit to panel** is the default.
- **No more "Take over".** Clicks, typing and scrolling always go straight to the page, even while an agent is using it. An **Agent is acting** chip in the toolbar shows when an agent drives the browser.
- **Several viewers share one page size.** With the panel open on your desktop and your phone, the one you used or focused last decides the size, and the others fit the page inside their panel. Opening the panel on another device no longer changes the page under you.
- **Agent screenshots use the current page size,** in CSS pixels, so a HiDPI screen doesn't double the image an agent gets back.

### Fixed

- **Agents can put screenshots on GitHub issues and pull requests again.** `attach_evidence` refused the file path CodeDen's own `browser_screenshot` prints (it lives in CodeDen's artifacts folder), so agents gave up or fell back to `gh`, which can't upload images. It now accepts a session's own screenshots by path, as `share_to_chat` does, and agents are told how images reach GitHub and to retry a CodeDen tool when the server is briefly unreachable during a restart.

- **The macOS desktop app no longer opens as "damaged".** Downloaded builds were reported as "CodeDen is damaged and can't be opened" on Apple silicon Macs, with no way past it, because the app wasn't signed at all. Builds without a Developer ID are now signed ad hoc, so macOS only says it can't verify the developer, which you allow once: open CodeDen, then choose **Open Anyway** under **System Settings › Privacy & Security**. Every release now checks the downloaded `.dmg` and `.zip` on macOS before it ships. If an older version still says "damaged", see [Unsigned builds](docs/desktop.md#unsigned-builds) for the one-line fix. These builds still can't update themselves; download new versions from GitHub Releases.
- **Saved API keys stay saved in the desktop app on Intel Macs.** The Intel build was missing the keychain module's binary, so API keys were kept in memory only and had to be entered again after a restart. They now go to the macOS keychain, as on Apple silicon.
- **New Claude models show up without restarting everything.** A model release changes Claude Code's model list even when nothing on your machine changes, and CodeDen kept the list it read when its background runner started; the runner keeps going when you restart CodeDen, so the picker could show an old Fable for days. CodeDen now asks again when the app reconnects (if the list is more than 10 minutes old), whenever a session starts, and when you refresh. It also finds `claude` and `codex` on your PATH each time instead of reusing the location from when the runner started, so moving to another install is picked up too.
- **Sessions on a full model id get their effort control back.** A session on, say, `claude-opus-5-5` (what Opus runs today) was shown as "isn't in the provider's list any more" with no effort levels. The picker now shows it as **Opus 5.5** with Opus's effort levels, and an id no entry covers still gets the default model's levels.
- **A second viewer of a still page now sees it straight away.** It used to wait for the page to change before its first frame arrived.
- **Scrolling in the browser panel is natural.** It now moves the page at the speed of your gesture, also for mice that scroll by lines.
- **Setup finds Claude Code and Codex where their installers put them.** After checking PATH, CodeDen also looks in the native installers' folders (`~/.local/bin` for Claude Code and Codex, `~/.claude/local`, Codex's standalone folder, and the GitHub CLI's default location), so a native install whose folder isn't on your PATH is found and used.
- **Broken installs are named, not hidden.** A leftover npm shim whose package is gone used to show as "Could not read the Claude login state". Now every copy CodeDen finds is checked before it's used: broken copies are skipped in favour of a working one, and when none works, the row says **installed but broken** and lists the paths, with how to fix it.
- **Re-check picks up PATH changes without a restart.** On Windows, **Re-check** (and the runner's provider re-detect) adds folders that were added to your user or system `Path` since CodeDen started, so the desktop app's long-running server and runner see newly installed tools. Agents and terminals started afterwards get the new PATH too.
- **Sign in runs the copy CodeDen found.** The setup **Sign in** buttons for Claude Code, Codex and GitHub run that copy by its full path, quoted for the terminal's shell (`& 'C:\Users\you\.local\bin\claude.exe' auth login` in PowerShell), instead of whatever `claude` means in the terminal.
- **"Could not read the login state" shows why.** The row's new **Details** show the underlying error (exit code and output).
- **Your requests always reach a project's PM.** Asking the orchestrator to hand a project some work could be turned away with "too many messages recently, wait a few minutes", even when you hadn't written to that PM in a long time: the reports from the PM's own running sessions were counted against it. The loop guard now only paces genuine back-and-forth between the orchestrator and a PM, or between a PM and its sessions, while you haven't stepped in, and anything you started goes straight through. When it does pace a message, the message is queued and delivered automatically, so nobody has to wait and retry.
- **The PM and the orchestrator no longer lose updates to a restart or a failed turn.** An update (an agent finished, a PM's answer) was counted as delivered before it reached them, so a runner restart at that moment, a server restart before their wake-up, or a turn that failed on an overloaded model dropped it, and the work it reported waited for you to notice. Updates now count as delivered only once the turn carrying them starts, wake-ups that a restart cut off happen after the restart, and when a turn carrying updates fails they're delivered again with a fresh wake-up (a few times, backing off). An answer to the orchestrator's question (`ask_pm`) also reaches it after a restart.
- **Queued messages survive a runner restart.** A message waiting for a session (from you, the PM or the orchestrator) was lost, and the session marked failed, if the runner was restarting when its turn came. It now stays in the queue and goes out once the runner is back. Messages from the orchestrator, a PM or an automation to an idle session wait in the queue instead of failing while the runner restarts, and the next queued message also goes out after a failed turn instead of waiting for you to type.
- **A PM or agent keeps its CodeDen tools after a failed turn.** When a turn failed (an overloaded or rate-limited model, say), the session's access to CodeDen's tools was revoked while its agent kept running, so its next turn couldn't start sessions, message the orchestrator or report back. Access now lasts until the session is stopped or completed.
- **Fewer false "Pipes a downloaded script straight into a shell" approvals.** Under Auto and Full, commands that pipe a download into a program that only reads it as data, such as `curl … | node -e '…'`, `curl … | python -c '…'` or `curl … | node scripts/x.mjs`, no longer ask. A `|` inside quotes (`sed 's|a|b|'`) no longer counts as a pipe either. Downloads piped into an interpreter that runs them (`curl … | sh`, `curl … | python3`, `irm … | iex`) still ask.
- **Claude sessions on Windows stop asking about files in their own worktree.** Once Claude Code's shell had run a command, it reported its folder in Git Bash form (`/c/Users/you/...`), and CodeDen read relative paths from it as if they were somewhere else. `rm -rf dist`, `pnpm test > test.log` or `cp a.ts b.ts` then asked as "outside the worktree", even under Full. They now run freely; files that really are outside the worktree still ask.
- **Fewer temp-folder approvals.** Copying files into the temp folder itself (`cp shot.png /tmp/`, `Copy-Item a.txt $env:TEMP`), using a `$tmp` or `$temp` variable for a folder made with `mktemp`, and `rm -rf *` inside the worktree or a folder in temp no longer ask, under Auto or Full. Copying a secrets file into temp, deleting the temp folder itself and emptying a folder outside the worktree still ask, and `cp file /etc` now asks as it should.
- **Reading global git config and single environment variables no longer asks.** `git config --global user.email`, `git config --global --list` and the like asked as "Changes global git configuration", even under Full; only commands that change it ask now. `printenv PATH` and `Get-ChildItem env:PATH` no longer ask as "Dumps environment variables" under Auto; dumping everything, or a variable whose name looks like a credential, still does.
- **Project managers and read-only sessions can look around more freely.** They were refused ordinary reading commands and wasted turns working around it: `cd x && git log`, `git -C <worktree> log`, `git --no-pager log`, `git stash list`, `sed -n 1,40p file`, `nl`, `gh search` and `gh api` GET requests now run. Anything that writes is still refused, including `sed -i`, `git stash` and `gh api` requests that send data.
- **Far fewer false "secrets file" approvals under Auto.** Searching for `process.env` or `import.meta.env` (with `grep`, `rg`, `Select-String` or Claude's search tool), adding `.env` to `.gitignore`, `test -f .env`, listing `*.pem` files, generating a local dev certificate, and creating an env file in the worktree (`cp .env.example .env`, or Claude writing `.env`) used to ask as secrets access. They now run freely. Reading a secrets file still asks, and so does writing one outside the worktree.
- **Claude's plans and memories no longer ask.** In plan mode Claude writes its plan to `~/.claude/plans`, and it saves memories to the project's auto-memory folder; both are outside the worktree, so each one asked for approval, even under Full. They now count like the temp folder under Auto and Full (honouring your `plansDirectory` and `autoMemoryDirectory` settings). Claude's settings and credentials still ask.
- **Agents can update their own pull request after a rebase.** `git push --force-with-lease` of the session's own branch no longer asks under Auto, and `create_pull_request` now pushes with a lease itself when a plain push is rejected after a rebase, instead of failing. Plain `--force`, force-pushing any other branch (including `main`), and deleting remote branches still ask. `git branch -d`, which refuses to delete unmerged work, no longer asks; `-D` still does.
- **Unattended work no longer waits forever on an approval.** In a Dark factory project, the PM's and the factory's sessions used to stop at an approval until you came back, holding up the whole factory. They now get a denial at once, with guidance to find a way that needs no approval or flag it for you. Sessions started by an automation, a PM or the factory in other modes wait 30 minutes for you, then get the same kind of denial, so a scheduled run finishes instead of blocking the next ones. Nothing is ever approved on your behalf, and sessions you start yourself wait for you as before.
- **Codex stops asking for ordinary work under Auto and Full.** Codex's sandbox keeps `.git` read-only and, under Auto, blocks the network, so it asked for approval for every `git commit`, `pnpm install` or `git push`, and under Full it couldn't commit at all. CodeDen now judges what Codex asks with the same rules as Claude: what your permission level allows is approved at once (shown in the transcript as approved by policy), and only risky actions, such as force pushes, writes outside the worktree or reading secrets, reach you. Full now lets Codex step outside its sandbox the same way, asking only for writes outside the worktree.
- **The browser panel keeps working on macOS for very large panels.** Above about 2560×1600, the picture used to be scaled below the page's own size, and on macOS Chrome then stopped sending pictures and reported the wrong page size, which put clicks in the wrong place. The picture now never goes below the page's size.
- **Quitting the desktop app can no longer hang.** If CodeDen's background server got stuck while closing, the app waited for it forever and never quit. It now stops the server after a short wait (forcing it if needed), a failed step while quitting no longer leaves the app open, and a server left behind by a crashed app exits by itself.
- **Agents, PMs and the orchestrator stop asking about things they can decide.** They now pick sensible defaults for routine details (approach, naming, scope, provider and model), say what they assumed so you can override it, and keep working; the orchestrator no longer ends replies with a menu of choices. They still ask you before destructive or irreversible steps, spending money or credentials, outward-facing actions such as publishing, releases, deploys or messages to people, and changes to protected areas.
- **Agents commit in their own worktree without asking.** A session started by a PM or an automation opens its pull request when the work is done; in a session you started, the agent opens one when you ask and otherwise offers it as a suggested follow-up. A question at the end of an agent's last message now reaches its PM instead of being cut off.
- **Stop always stops.** A turn whose agent never answered the stop request could stay "Working" forever; it now ends within 10 seconds either way. Messages you sent into a Claude turn that the agent hadn't read yet are dropped with it, instead of starting a new turn right after you pressed Stop, and the transcript says they weren't delivered.
- **No more dead approvals after a crash.** When CodeDen's background runner was killed or crashed, approvals and questions from the agent's cut-off turn stayed open in the inbox and could keep the session "Waiting" or "Working" long after it resumed. They're now cancelled before the session continues; questions an agent asked with `ask_user` stay open, since they can still be answered.
- **Agents hear about failed setup commands.** When a worktree setup command from `.codeden/project.json` failed, the session started anyway and the agent ran into confusing errors without knowing why. Its first message now begins with the command that failed, its exit code and the end of its output.
- **You can see when Claude is retrying or compacting.** A Claude session that hit an overloaded or rate-limited API, or was compacting a long conversation, looked stuck while Claude Code recovered by itself. The transcript now shows "The API request failed (overloaded, 529); Claude Code retries in 12s (attempt 2 of 10)", updated as the attempts go up, and "Compacting the conversation…" until it reads "Context compacted" (or says why it failed).
- **New sessions start from the latest code.** In a GitHub project, a session's worktree was branched from your local default branch, even when it was days behind GitHub, so agents worked on old code and opened pull requests with conflicts. CodeDen now fetches first and branches from the default branch on GitHub when your local one is only behind; a local default branch with commits of your own is still used as it is, and offline it carries on with the local one. CodeDen's git also never opens a Git Credential Manager sign-in window in the background.
- **Archived sessions free their disk space on Windows.** A dev server an agent started through its shell kept running after the agent stopped, kept the worktree in use, and the worktree (often with a large `node_modules`) could never be removed, silently. CodeDen now ends what its agents left running in a worktree when the session stops and before the worktree is removed; your own editors and terminals are left alone. A removal that still fails appears in the inbox under **Worktrees not removed**, with **Try again**, and the desktop app now always keeps its server log in `~/.codeden/logs/desktop-server.log`.

## [0.4.4] - 2026-11-09

### Added

- **Read-aloud speaks a TL;DR.** **Settings › Voice › What to read** chooses between **TL;DR** (the default: one or two sentences saying what was done and whether anything needs you, about 15 seconds at most) and **Full message** (the whole final message without code or Markdown, up to 5,000 characters). This replaces the **Read-aloud summaries** switch under Utility model.
- **Read-aloud says who's speaking.** Each message starts with who it's from, such as "Orchestrator", "codeden project manager" or "codeden-website, Improve FAQ", so you can tell sessions apart across projects. Turn it off with **Settings › Voice › Say who's speaking**.
- **Read-aloud queues messages.** When another session finishes while a message is being read, its message now waits and plays next instead of cutting the first one off. Up to three messages wait; messages from sessions you mute, or that arrive in quiet hours, are skipped when their turn comes. Switching read-aloud off stops it and clears the queue.

### Changed

- **A tidier session header.** The model and permission level are shown only under the message box, no longer repeated at the top of a session.

### Fixed

- **Read-aloud no longer reads long reports when a summary can't be made.** If the utility model fails or is unavailable, CodeDen now reads the message's first sentence or two instead of up to 600 characters (or the whole report, when the request itself failed). Summaries that run long are cut to two sentences.
- **Utility model failures are logged.** Failed session titles, follow-ups and read-aloud summaries are written to the server log (`~/.codeden/logs/desktop-server.log` in the desktop app, the terminal for `codeden`) instead of being dropped unless debugging was on.
- **The factory's size limit no longer stops large work.** It used to count every line, including lockfiles and copied-in UI components. A new project's scaffold failed at 800 lines and 40 files, went through a fix round that couldn't succeed, and ended up waiting on you. Now:
  - only code someone has to review counts, so lockfiles and generated or vendored files (shadcn's `components/ui` included) are left out;
  - the default is 5,000 lines with no file limit, and projects on the old defaults move over automatically;
  - the **Merge checks** section of the factory panel's **Limits** dialog sets **Largest change** and **Most files changed**; leave either empty for no limit;
  - the PM sees the limit at triage and splits big work, or accepts work that can't be split (an initial scaffold, a stack migration) as one change;
  - a PR that's still too large goes to the PM to split or allow, with no fix round, without counting towards pausing the loop, and without waiting on you.
- **Saving one factory setting no longer resets the others** to their defaults.

## [0.4.3] - 2026-11-09

### Changed

- The npm page and the desktop app's package metadata now link to the website, [codeden.app](https://www.codeden.app).
- **Livelier PR checks.** In a pull request's checks, a running check shows a spinner, a queued one a softly pulsing dot, and finished ones a tick, a cross or a dash, with short labels ("Running", "Queued", "Passed", "Failed", "Skipped", "Timed out") instead of GitHub's raw status strings. When a check finishes while you're watching, its tick draws in (a cross gives a small shake). The checks badge spins while anything is running and adds a small progress bar until everything passes. With reduced motion turned on, the icons stay still.

## [0.4.2] - 2026-11-09

### Changed

- **Dark factory no longer waits on you.** The project manager and the factory's own sessions used to stop and ask questions, which left the loop waiting. Now they decide from the vision (which wins over the current code) and carry on. Each decision lands in your inbox as **Factory decided** and in the daily digest, with what was decided and why. Calls that are yours to make (protected areas, a missing or self-contradicting vision, anything irreversible outside the code) are flagged as **Factory needs you** without stopping the rest of the work. Sessions you start yourself still ask as usual.

## [0.4.1] - 2026-11-09

### Changed

- **The sidebar reads as a tree.** The rows under a project (Project manager, sessions, Automations, archived) are indented under it with a guide line, and expanded automations nest one level further, so it's clear which project each row belongs to.

## [0.4.0] - 2026-11-08

### Added

- **Open CodeDen from your phone or tablet.** **Settings › Network access** (off by default) lets devices on your network, or on your own VPN such as Tailscale, open CodeDen after signing in with a password. Set one (at least 15 characters; very common passwords and simple sequences are refused) or **Generate** a five-word passphrase, shown once. Turning it on moves only CodeDen's web listener to your network addresses on the same port; agents and the runner carry on. Settings lists every address with a **QR code** to scan, and the signed-in devices with **Sign out** and **Sign out all**. `codeden password` and `codeden network on|off` do the same from a terminal. See [Phones, tablets and network access](docs/remote-access.md).
- **Works on phones and tablets.** The sidebar becomes a slide-out drawer (or stays a slim rail on a tablet in landscape), the right panel opens as a sheet over the transcript, and screens fit without sideways scrolling, with tap targets of at least 40 px and row menus that don't need hover.
- **Add to Home Screen.** CodeDen has a web app manifest and icons, so adding it to your home screen opens it full screen like an app.

### Security

- Network access keeps the runner and the agents' MCP endpoint on 127.0.0.1, never accepts the install token from another device, stores only a salted scrypt hash of the password and hashes of session tokens, throttles failed sign-ins per address (with a 15-minute lockout after ten), and keeps the `Host` and `Origin` checks, extended only to the computer's own network addresses while it's on.

### Fixed

- **Desktop update checks while a release is being published.** The GitHub Release now stays a draft until every installer and update file is attached, so the desktop app no longer reports "Couldn't check for updates … 404" during a release. A release that has no update file for your platform yet counts as up to date, and GitHub hiccups (5xx, timeouts) are retried twice before a plain "Couldn't reach GitHub" message.

## [0.3.0] - 2026-11-08

### Added

- **Create automations in one editor.** **New automation** on a project's Automations page opens a single editor: name and target (this project or all projects); when it runs, as plain choices (every few minutes or hours, daily, weekdays, weekly, monthly, or custom cron) with a summary such as "Every weekday at 09:00", the next three runs and a timezone, or when something happens ("When a pull request's checks fail"), or only when you run it; the prompt with **Insert placeholder**; the agent (provider, model, effort); permissions; and advanced options tucked away. Save it on or off, or **Save and run now**. Templates open in the same editor to tweak first, and everything stays editable on the automation's page, with **Duplicate** and **Delete**. Automations from files show **From file** and offer **Duplicate to edit**.
- **Share automations.** Export one as a Markdown file (download or copy) or a project's as a `.zip`, and **Import** `.md` files, a zip or pasted text, with a preview of each automation and its errors. The files use the same format as `.codeden/automations/`, imports never run anything and always start off, and Full permissions are flagged.
- **Read-only permissions.** A new level below Supervised, so the ladder is **Read-only, Supervised, Auto, Full**, shown as **Permissions** in the composer, the new-session dialog and the automation editor. Read-only agents can read and run checks (tests, lint, type checks) but never edit files, commit or push; Claude enforces it per tool call and Codex with its read-only sandbox.
- **The PM can set up automations.** PMs have `create_automation` and `update_automation`; what they create starts off and is marked **Created by the PM**.
- **Messages from the PM and the orchestrator stand out.** In a session's thread, a message the project manager or the orchestrator sent is a card with the sender's badge and rendered Markdown, instead of a plain user bubble. The sender is recorded with the message.
- **Projects pick up a GitHub remote added later.** A local folder that later gets `git init` and a GitHub `origin` becomes a GitHub project: CodeDen checks again on start, after each agent turn in a local-only project, and with **Check again** in the GitHub tab, the session's Issue / PR panel and the Autonomy dialog. If a GitHub project's `origin` disappears, CodeDen warns instead of downgrading it, and offers **Make local-only**.

### Changed

- **Archiving removes the worktree instantly**: the folder moves to `~/.codeden/wt/.trash` and is deleted in the background. A worktree with uncommitted changes is still kept unless you choose **Remove anyway**, and the toast says when changes were discarded. If a file in the worktree is in use, the toast offers **Try again**, and the hourly cleanup retries archived sessions on its own. The branch and checkpoints stay.

### Fixed

- **A slow-starting runner is no longer killed and relaunched.** CodeDen used to give a new runner 20 seconds, then kill it and start another, forever on a machine where start-up takes longer (security software, a slow disk). It now waits for a runner that is still starting (up to five minutes), the sidebar says **Starting the runner…**, and a runner that crashes during start-up is reported at once with the end of `logs/runner.log`.
- **Dictation and pasted images in a new orchestrator or PM chat.** Before its first message, the orchestrator and PM chats now have the full composer input: the dictation button and shortcuts, image and file paste, drag-and-drop and the attach button. The first message, which starts the session, carries its images.
- **Archiving no longer leaves half-deleted worktrees on Windows.** Git deletes the contents of folders that a pnpm `node_modules` junction points to, and it stops at a dangling junction, so removing a pnpm-installed worktree failed halfway with "is not a working tree". CodeDen now deletes worktrees itself without ever following a symlink or junction. It cleans up the folders earlier versions left behind for archived sessions (about a minute after CodeDen starts), and recreates a session's worktree over such a leftover. If a file is in use, nothing is deleted and the toast offers **Try again**.
- **Long questions and answers in question cards wrap** instead of overflowing; long answered questions are clamped with **Show more**.
- **A session started just as the runner connects is no longer marked failed.** Recovery after a runner restart could mistake it for a session cut off by the restart.
- **The PM and the orchestrator no longer miss an update that arrives while they are being woken.** Such a notice (for example, that an agent finished) used to stay undelivered until something else woke them.

## [0.2.0] - 2026-11-08

### Added

- **Local Whisper dictation.** A new **Local (Whisper)** dictation engine transcribes on your own machine, offline, in any browser and in the desktop app. Pick a model in Settings > Voice (tiny, base or small, English-only or multilingual), download it with live progress (resumable, checksum-verified, deletable) and try it with **Test**; first-run setup offers it too. Where the browser has no working speech recognition, CodeDen now says so and suggests Local (Whisper).
- **The desktop app.** CodeDen for Windows, macOS and Linux as an installable app, from GitHub Releases: no Node.js needed, same data as `npx codeden` (it attaches to a running CodeDen or starts its own). Its own window, a tray (menu bar) icon with running and waiting agents, the app icon badge, system notifications, the system folder picker for new projects, `codeden://` links, keep-awake while agents run, open at login and close to tray (**Settings > App**). It updates itself from GitHub Releases through the same update banner and **Updates** setting, stopping the runner gracefully before installing so sessions resume afterwards. See [The desktop app](docs/desktop.md).
- Claude Code support installs without npm when there is none (straight from the registry, checked against its published checksum).
- **Archive sessions.** **Archive session** in the session menu stops the session, hides it from the sidebar and removes its worktree; **Unarchive** (or sending it a message) brings it back.
- **Worktree cleanup.** Worktrees of sessions inactive for 7 days are removed automatically, unless the pull request is still open or there are uncommitted changes; archiving a project cleans up its sessions' worktrees. Configure it in Settings > General > Worktrees. Branches and checkpoints are kept, and the worktree is recreated from its branch the next time you message the session.
- **Know when an agent is waiting on you.** When an approval or a question arrives, CodeDen plays a short chime (once per burst; Settings > Notifications > **Sound when an agent needs you**, with a Test button) and keeps a toast on screen until you open the item or it is resolved; **Open** goes straight to the session. While anything is waiting, the tab icon gets an amber dot and a background tab's title alternates with "⏳ Waiting on you". The first such toast offers, once, to turn on desktop notifications.
- **One picker for provider, model and effort.** A single control in the composer, the new-session dialog, automations and Settings, with search across providers, favourites and hidden models.
- **Custom model ids.** Add model ids a provider doesn't list, per provider, in Settings > Providers; they appear in the picker marked Custom.
- **Claude Code's real model list** loads as soon as CodeDen starts, without running a session or sending a request.
- **Change autonomy on a running session.** The composer's autonomy picker now changes the live session: Claude from the next tool call, Codex from the next turn.
- **Queued messages you can see.** Messages sent while the agent is busy wait in a tray above the composer, where you can edit, delete or send them now (steering the running turn).
- **Pin and reorder projects** in the sidebar, with row menus for sessions and projects and a home for archived sessions.

### Fixed

- Risky-action checks read commands like a shell: they follow `cd`, and multi-line arguments such as heredoc commit messages are no longer split into separate commands. Writes to the OS temp folder no longer ask in Auto and Full.
- Turn diffs and checkpoints could miss a file rewritten in the same second as the snapshot (seen on Linux).
- Pasted images show from their artifact instead of a file path, and long tool-call summaries stay inside the transcript column.
- `codeden stop` also stops a runner that the server was still starting when it shut down (for example right after an update), so no runner is left running in the background.
- **Codex models in the model pickers.** Codex's full model list, with each model's reasoning efforts, shows up as soon as CodeDen starts, with no need to run a Codex session or reload the page first. It is loaded again after a setup re-check (for example once you have logged in), and new model lists reach open pages live. Choosing **Max** for a Codex model that offers it now sends `max` instead of `xhigh`.

## [0.1.1] - 2026-11-07

### Added

- **One-click updates.** CodeDen checks npm on start and every 6 hours; a banner offers the new version with **What's new** (release notes), **Update now** and **Later**. Update now installs the version side by side into `~/.codeden/app/<version>/`, restarts CodeDen into it and reconnects the page; running sessions are drained and resumed. Progress, failures with Retry, and a manual restart command when CodeDen can't restart itself.
- The `codeden` launcher: any copy you run (npx, global) starts the newest installed version from `~/.codeden/app/current.json`, in the same process. Source checkouts never switch.
- `codeden update` and `codeden update --rollback`; **Roll back** in Settings > About; `codeden doctor` lists installed versions and which one starts.
- Settings > General > **Updates**: Off, Notify me (default) or Install automatically (downloads in the background for the next launch).

### Changed

- The update check runs every 6 hours instead of once a day, and the "Check for updates" switch became the Updates setting (an existing "off" stays off).
- The published entries read their version from `package.json` at runtime.

## [0.1.0] - first public release

The first public release of CodeDen, a local-first harness for coding agents. Install with `npx codeden`.

### Daily driver

- **Claude Code** through the Claude Agent SDK (using your installed `claude` and its login) and **Codex** through `codex app-server`, behind one normalized event model.
- Agent sessions in their own **git worktrees and branches**, with `.codeden/project.json` setup commands.
- A transcript with grouped tool calls, plans and todos, subagent threads, and approval and question cards answerable inline.
- **Autonomy levels**: Supervised, Auto with risky actions asking (the default) and Full autonomy, mapped onto each provider's native enforcement.
- **Turn checkpoints** in hidden git refs: per-turn and whole-session diffs and file restore.
- **Workbench**: file tree and editor, runner-owned terminals that survive server restarts, and a browser the agents drive and you can take over.
- **Agent configuration** editors for memory files, skills, subagents and MCP servers, written to each provider's native files with a diff preview and a backup.
- **Image generation** for every agent through one `generate_image` tool (Codex, Gemini, OpenAI Images).
- **Voice**: dictation with push-to-talk and read-aloud of final messages.
- **Follow-up prompt chips** when a turn completes.
- First-run setup that detects and reuses existing Claude Code, Codex, GitHub and git setups, and `codeden doctor`.

### Orchestration

- An **orchestrator** across projects and a read-only **project manager** per project, with status digests on every wake and typed notices.
- **Work keys and conflict detection** with wait, skip, join and force.
- One **inbox** for questions, approvals, PRs ready for review, failed runs, triage decisions and conflicts.
- **GitHub** issue, PR, check and review sync through `gh`, PRs that link their issue and session, and screenshots and test output on the `codeden/evidence` branch.
- **Usage and cost reports**: a per-turn ledger, reported versus estimated costs, API-equivalent cost for subscriptions, rate-limit windows, budgets and alerts, and CSV export.

### Automations

- A scheduler with cron, event and manual triggers, guards (overlap policy, concurrency, quiet hours, daily caps, catch-up), runs history and per-project switches. All off by default.
- Built-in templates: security audit, refactor sweep, dependency updates, UI review, test coverage gaps, issue triage and stale PR follow-up. Custom automations as Markdown files.
- Issue triage by the PM, with a "Should I take this on?" inbox decision.

### Autonomy modes (experimental)

- Project modes Manual, Assisted (the default), **Autopilot** and **Dark factory**.
- A `.codeden/VISION.md` editor with protected areas, the factory loop, merge checks with an independent cross-provider review, automatic squash merge and automatic revert, server-enforced limits, a per-project and global kill switch, the factory panel and a daily digest.
