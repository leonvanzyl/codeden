# Workbench

Everything an agent touches sits next to its chat. Open the right panel with **Ctrl/Cmd+\\** and switch tabs with **Alt+1** to **Alt+6**.

| Tab | Shortcut | What's there |
|---|---|---|
| Diff | Alt+1 | Session, uncommitted and per-turn diffs, file restore, commit and push |
| Files | Alt+2 | The worktree's file tree and a file viewer |
| Browser | Alt+3 | The session's browser, shared with the agent |
| Terminal | Alt+4 | Terminals in the worktree |
| Issue / PR | Alt+5 | The linked issue and pull request (see [GitHub](github.md)) |
| Details | Alt+6 | Status, purpose, work key, who started it, what it was forked from, provider, autonomy, branch, worktree, scope, what's loaded, read-aloud mute |

## The transcript

- Streaming Markdown with syntax-highlighted code.
- Tool calls are grouped into collapsible **work blocks** ("Ran 2 commands and called 1 tool") with live command output.
- **Plans and todos**, **subagents**, **approvals** and **questions** get their own cards. Approvals and questions are answered right in the card (or from the inbox).
- **Subagents** run as child threads. Their card shows live status and, once the subagent finishes, what it cost and the tokens, tool calls and time it used (e.g. `≈ $0.42 · 48.2k tokens · 23 tool calls · 1m 12s`) when the provider reports them. Hover the figures for the cost per model, split into input, output, cache reads and cache writes. The cost is priced like the session's: `≈` marks an estimate from list prices, and with a subscription login it is the API-equivalent cost. It is part of the turn's cost, not added on top. Click the card to open the child thread in a side panel. Approvals raised inside a subagent surface in the parent and in the inbox.
- Each turn's footer shows how long it worked and, where available, its cost and tokens. The session header shows the running total.

## The composer

- Text, pasted images and file attachments.
- `@` to mention files, `/` for commands and skills.
- Pickers for **provider**, **model** and **reasoning effort**, plus the session's **Permissions** (Read-only, Supervised, Auto or Full; see [Security](security.md#permissions)). Model and effort can be changed mid-session; they apply from the next turn. Permissions can be changed too: the level is saved on the session and applies from the next tool call where the provider allows (Claude), otherwise from the next turn (Codex).
- **Plan** (agent sessions, on providers with a plan mode: Claude Code today): the agent explores and proposes a plan before it changes anything. Turn it on in the composer, in a new session before its first message or any time after. The plan arrives as a card: **Approve plan** and the agent implements it with the session's permissions, or **Keep planning** with a note on what to change. While it plans, edits and writing commands are refused (see [Security](security.md#plan-mode)).
- **Your own models in the picker:** star models to pin them to Favourites, hide the ones you never use, and add **custom model ids** a provider doesn't list yet (Settings › Providers › Custom models). A custom id is marked *Custom*, gets the effort levels of the provider's default model, and is sent to the provider unchanged; if the provider doesn't know it, the turn fails with the provider's error.
- **While a turn runs:** Enter **queues** your message for when it ends. With providers that support it, you can **steer** instead, injecting the message into the running turn.
- **Stop** the running turn with **Ctrl/Cmd+.**.
- The **microphone** button dictates (see [Voice and images](voice-and-images.md)).

### Follow-up chips

When a turn completes, two to four suggested next prompts appear as chips above the composer. The agent proposes them with `suggest_followups` as its last action; if it didn't, the [utility model](#the-utility-model) suggests some from the final message and the turn's changes. A click fills the composer so you can edit before sending; **Settings → General** can make a click send straight away, or turn chips off.

![Follow-up chips after a turn, next to the per-turn diff](images/session.png)

## Diffs and checkpoints

At the end of every turn the runner snapshots the worktree into a hidden ref, `refs/codeden/checkpoints/<session>/<n>`. It uses a temporary index, so your branch, your index and your working copy are never touched. That gives you:

- **All changes:** everything the session changed since it started.
- **Uncommitted:** what's not committed yet.
- **Per turn:** exactly what one turn changed.
- **Restore:** put files (one, or all of them) back to the session's starting point or to the state before a turn.

The **git bar** at the top shows the branch, ahead/behind and the uncommitted count, with **Commit** and **Push**. In a GitHub project it also has **Open PR**, which asks the agent to open a pull request for the session's work (sent now, or queued behind a running turn). Once the session has an open PR, the button becomes **PR #N** and opens the Issue / PR tab. A successful push offers the same next step in its notification. **Open PR** is shown for sessions you started on their own branch; read-only and archived sessions don't get it, and sessions a PM, automation or the factory started open their own pull requests.

### Comment on lines

Review the agent's changes line by line and send your notes back in one go:

1. **Hover a line** in the Diff panel and click the **+** by its line number. To comment on several lines, drag the **+** over them, or pick them by their line numbers first (Shift+click extends the range) and then click **+**.
2. **Write the comment** in the box that opens under the lines, then click **Comment** (or press **Ctrl/Cmd+Enter**). **Esc** cancels. Saved comments stay under their lines with **Edit** and **Delete**.
3. **Collect as many as you like**, across files. The bar under the toolbar counts them. They stay while you switch to another panel tab or session, and only go when you send or discard them. A comment shows in the diff view you wrote it in (all changes, uncommitted or one turn); the count covers every view.
4. **Send to agent** turns them into one message: for each comment, the file, the side and lines ("new lines 37–39" in the changed file, "old line 12" in the file before the change), the quoted diff lines and your text. It's sent right away, or queued behind the running turn like any message (you can still edit it in the queue). While it's on its way, the comments in it read **Sending…** and can't be changed, even if you leave the panel; comments you start meanwhile stay for your next review. **Discard** throws the drafts away.

Drafts are kept in the app's memory, like the composer's draft, so reloading the page clears them.

## Fork a session

Want to try a second approach without losing the first? Open the session's **⋯** menu and choose **Fork session**, or use **Fork this session** in the command palette (**Ctrl/Cmd+K**). CodeDen starts a new session in the same project:

- **Same conversation.** The agent continues from where the original left off, through the provider's own fork. It remembers everything said so far.
- **Same code.** The new session gets its own worktree on a new branch, created from the original's branch. The original's files at the end of its last turn are copied in, including changes it hadn't committed yet, before setup runs. The conversation and the code are taken at the same moment, even right after a turn ends.
- **Always in its own worktree.** If the worktree can't be made, the fork shows as failed. Your next message to it tries again, and the agent never runs in the project folder itself.
- **Same agent.** It keeps the provider, model, effort, permissions and linked issue. Its pull request targets the same base branch. If the original is still planning, the fork keeps planning too, and implements once you approve its own plan.
- **Original unchanged.** Nothing about the original session changes. Both can carry on side by side.

The fork's header shows **Fork of …** with a link back, and **Details** shows where it was forked from. Fork is offered when the provider supports it (Claude and Codex do). It's available once the session has had a turn and while no turn is running; while a turn runs, the menu says why it's disabled.

### Fork from an earlier turn

Did the agent go the wrong way a few turns ago? Hover the line under that turn's last message (where it says how long the turn took) and choose **Fork from here**. On a touch screen it's always shown. The new session is like any fork, except that:

- **The conversation ends with that turn.** The agent remembers everything up to and including it, and none of the turns after it.
- **The code is as it was right after that turn**, uncommitted changes included, in a new worktree and branch.

The original session is unchanged. The fork's empty transcript and **Details** say which turn it was forked from. You can fork from turns that ran in this version of CodeDen or later; for older turns, only the latest one offers it, and forking from it is the same as **Fork session**. If the agent's own record of the conversation changed since that turn (it was replaced or deleted), CodeDen says it can't fork from there and creates nothing, rather than copying the whole conversation.

## Files

A tree of the worktree with a syntax-highlighted viewer. Binary files are detected and skipped.

## Terminal

Terminals are real PTYs (node-pty) owned by the **runner**, so they survive a server restart and keep their scrollback. Each session has a terminal in its worktree, and you can open more. **Ctrl/Cmd+J** toggles a bottom terminal drawer.

The shell is PowerShell on Windows and your `$SHELL` elsewhere. Set `CODEDEN_SHELL` to use another (for example `pwsh.exe` or `C:\Program Files\Git\bin\bash.exe`).

![A terminal in the session's worktree](images/terminal.png)

## Archiving and worktree cleanup

**Archive** stops the session, hides it from the sidebar and removes its worktree. It's in the session's menu in the sidebar (right-click the row, use the **⋯** button that shows on hover, or press **Shift+F10** or the menu key) and in the **⋯** menu of the thread header. The same menu opens, renames, copies a link to, and stops the session. The toast offers **Undo**. If the worktree has uncommitted changes it is kept, and the toast also offers **Remove anyway** (it then says the changes were discarded). If something still has a file in the worktree open (a terminal, a dev server, an editor), nothing is deleted and the toast offers **Try again**; CodeDen also retries on its own every hour. Archiving a project cleans up the worktrees of its sessions that aren't working.

Archived sessions live on the project home: an expanded project in the sidebar ends with an **N archived** row that opens the project's sessions on the **Archived** filter, where each one has **Unarchive**. The command palette (**Ctrl K**) still finds archived sessions and labels them **Archived**.

CodeDen also removes worktrees on its own once a session has been inactive for 7 days, unless its pull request is still open or the worktree has uncommitted changes. Change the number of days, or switch this off, in **Settings → General → Worktrees**.

Nothing is lost unless you choose **Remove anyway**: the branch and the turn checkpoints stay (the checkpoints also hold what each of the agent's turns left uncommitted). A removed worktree is moved into `~/.codeden/wt/.trash` and deleted in the background, so archiving is instant even with a large `node_modules`. A cleaned-up worktree shows a dashed worktree chip in the header. When you message the session again, CodeDen recreates the worktree at the same path from its branch, runs your setup commands and carries on. Messaging an archived session also unarchives it.

## Browser

The runner launches one Chromium (your installed **Edge** or **Chrome**; Edge first on Windows, Chrome first elsewhere) and gives every session its own browser context, so cookies, storage and tabs never cross sessions.

- **You see the page** live in the Browser tab, edge to edge. The page is laid out at the panel's own size and pixel density, so it is sharp and re-flows as you resize the panel (pick a fixed device size under **⋯ > Viewport** instead if you want one). Clicks, typing and scrolling always go straight to the page, even while an agent is using it; an **Agent is acting** chip shows when it is. Tabs, back, forward, reload and the address bar work as you'd expect.
- **Several viewers** (say, your desktop and your phone) share one page size: the one you used or focused last decides it, and the others fit the page inside their panel.
- **Agents drive the same tabs** with CodeDen's browser tools:

| Tool | Does |
|---|---|
| `browser_navigate` | Open a URL (starts the browser on first use) |
| `browser_snapshot` | An accessibility snapshot with element refs |
| `browser_click`, `browser_type`, `browser_press` | Act on a ref, or press a key or chord. Without a ref, `browser_type` types into whatever has focus |
| `browser_mouse` | Click, hover, drag or scroll at a point, for canvases, maps, drag handles, sliders and hover menus that have no useful ref. Points are the page's CSS pixels from the top-left corner of the visible area: the pixels of a viewport `browser_screenshot`, not of a `fullPage` or element (`ref`) one. Points outside the visible area are refused |
| `browser_dialog` | Answer the page's alert, confirm or prompt (OK or Cancel, and the prompt's text) |
| `browser_screenshot` | Viewport, full page or one element; `share: true` posts it to the chat |
| `browser_logs` | Console and network entries |
| `browser_wait` | For a selector, text or network idle |
| `browser_evaluate` | Run a small JavaScript expression (5 s timeout, size-capped result) |
| `browser_open_dev_server` | Open `localhost:<port>`, or the only running dev server |

- **Dialogs wait for an answer.** When the page opens an `alert`, `confirm` or `prompt` (a "Delete this item?"), the page pauses and the panel shows the dialog over it with **OK** and **Cancel** (and a text field for a prompt). You or the agent can answer it; the panel says who did. A dialog nobody answers is dismissed after 2 minutes, so a page never waits forever. When you or an agent navigate away with the address bar or the browser tools, a page's "Leave site?" is accepted on its own.
- **Dev servers** running on your machine are discovered, so you and the agents can open them in one click.
- Screenshots can be shared to the chat (`share_to_chat`) or attached to a PR or issue as [evidence](github.md#evidence).
- `chrome://`, `edge://`, `devtools://` and `javascript:` URLs are refused.

![The browser panel filling the right side, with the page laid out at the panel's size](images/browser-panel.png)

## Command palette and shortcuts

**Ctrl/Cmd+K** opens the command palette: jump to any project, session or page, or run a command. **Shift+?** lists every shortcut.

| Shortcut | Action |
|---|---|
| Ctrl/Cmd+K | Command palette |
| Shift+? | Keyboard shortcuts |
| Ctrl/Cmd+Shift+L | Toggle light / dark |
| Ctrl/Cmd+, | Settings |
| Alt+O / Alt+I | Go to the orchestrator / inbox |
| Ctrl/Cmd+B | Toggle the sidebar |
| Ctrl/Cmd+\\ | Toggle the right panel |
| Ctrl/Cmd+J | Toggle the terminal drawer |
| Alt+1 ... Alt+6 | Right-panel tabs |
| / | Focus the composer |
| Enter / Shift+Enter | Send (queue while running) / new line |
| Ctrl/Cmd+. | Stop the running turn |
| Ctrl/Cmd+Shift+M | Start / stop dictation |

## The utility model

Small side jobs use one cheap model so they never need a separate API key: follow-up suggestions, read-aloud summaries, session titles and short summaries in notices. It runs as a one-shot, tool-less call through an installed provider (a small Claude model by default, or a small Codex model when only Codex is set up). When only OpenCode is set up, or you pick OpenCode without a model, CodeDen uses the cheapest model OpenCode lists from the same provider as its default model, by listed price (for example Haiku when the default is an Anthropic model), never another provider's model. If OpenCode lists no prices, its default model is used. Pick the model and switch each job off in **Settings → Utility model**; whether read-aloud uses a TL;DR is chosen in **Settings → Voice → What to read**. When a job fails, the reason is written to the server log.
