# Workbench

Everything an agent touches sits next to its chat. Open the right panel with **Ctrl/Cmd+\\** and switch tabs with **Alt+1** to **Alt+6**.

| Tab | Shortcut | What's there |
|---|---|---|
| Diff | Alt+1 | Session, uncommitted and per-turn diffs, file restore, commit and push |
| Files | Alt+2 | The worktree's file tree and a file viewer |
| Browser | Alt+3 | The session's browser, shared with the agent |
| Terminal | Alt+4 | Terminals in the worktree |
| Issue / PR | Alt+5 | The linked issue and pull request (see [GitHub](github.md)) |
| Details | Alt+6 | Status, purpose, work key, who started it, provider, autonomy, branch, worktree, scope, what's loaded, read-aloud mute |

## The transcript

- Streaming Markdown with syntax-highlighted code.
- Tool calls are grouped into collapsible **work blocks** ("Ran 2 commands and called 1 tool") with live command output.
- **Plans and todos**, **subagents**, **approvals** and **questions** get their own cards. Approvals and questions are answered right in the card (or from the inbox).
- **Subagents** run as child threads. Their card shows live status; click it to open the child thread in a side panel. Approvals raised inside a subagent surface in the parent and in the inbox.
- Each turn's footer shows how long it worked and, where available, its cost and tokens. The session header shows the running total.

## The composer

- Text, pasted images and file attachments.
- `@` to mention files, `/` for commands and skills.
- Pickers for **provider**, **model** and **reasoning effort**, plus the session's **Permissions** (Read-only, Supervised, Auto or Full; see [Security](security.md#permissions)). Model and effort can be changed mid-session; they apply from the next turn. Permissions can be changed too: the level is saved on the session and applies from the next tool call where the provider allows (Claude), otherwise from the next turn (Codex).
- **Plan** (agent sessions, on providers with a plan mode: Claude Code today): the agent explores and proposes a plan before it changes anything. Turn it on in the new-session dialog or the composer. The plan arrives as a card: **Approve plan** and the agent implements it with the session's permissions, or **Keep planning** with a note on what to change. While it plans, edits and writing commands are refused (see [Security](security.md#plan-mode)).
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

The **git bar** at the top shows the branch, ahead/behind and the uncommitted count, with **Commit** and **Push**.

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
| `browser_click`, `browser_type`, `browser_press` | Act on a ref, or press a key or chord |
| `browser_screenshot` | Viewport, full page or one element; `share: true` posts it to the chat |
| `browser_logs` | Console and network entries |
| `browser_wait` | For a selector, text or network idle |
| `browser_evaluate` | Run a small JavaScript expression (5 s timeout, size-capped result) |
| `browser_open_dev_server` | Open `localhost:<port>`, or the only running dev server |

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

Small side jobs use one cheap model so they never need a separate API key: follow-up suggestions, read-aloud summaries, session titles and short summaries in notices. It runs as a one-shot, tool-less call through an installed provider (a small Claude model by default, or a small Codex model when only Codex is set up). Pick the model and switch each job off in **Settings → Utility model**; whether read-aloud uses a TL;DR is chosen in **Settings → Voice → What to read**. When a job fails, the reason is written to the server log.
