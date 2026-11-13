# The CodeDen desktop app

The desktop app is CodeDen as an app on your computer: its own window, a tray (menu bar) icon that shows what your agents are doing, notifications, a badge for things waiting on you, and automatic updates. It runs the same server, runner and UI as `npx codeden`, on the same data, so you can use either and switch whenever you like.

You don't need Node.js or npm for the desktop app. You still need the tools your agents use (git, and Claude Code and/or Codex), exactly as with `npx codeden`.

## Install

Download the installer for your system from the [latest GitHub Release](https://github.com/leonvanzyl/codeden/releases/latest):

| System | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `CodeDen-Setup-<version>.exe` | Installs for your user only (no admin prompt) into `%LOCALAPPDATA%\Programs\CodeDen`, with Start menu and desktop shortcuts and an uninstaller (Settings > Apps) |
| macOS (Apple silicon) | `CodeDen-<version>-arm64.dmg` | Drag CodeDen to Applications |
| macOS (Intel) | `CodeDen-<version>-x64.dmg` | |
| Linux (x64) | `CodeDen-<version>-x86_64.AppImage` | `chmod +x` it and run it; it can update itself |
| Debian/Ubuntu (x64) | `codeden_<version>_amd64.deb` | `sudo apt install ./codeden_<version>_amd64.deb` |

### Unsigned builds

Releases carry a publisher signature only when the project's signing certificates are configured. Without one the app works, but your system warns you the first time you open it.

#### Windows

SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**.

#### macOS

Without a Developer ID, the macOS app is signed ad hoc and isn't notarized by Apple, so macOS can't verify who made it. You allow it once:

1. Open the `.dmg` and drag **CodeDen** to **Applications**.
2. Open CodeDen from Applications. macOS says it can't verify that CodeDen is free of malware (or that it's from an unidentified developer). Choose **Done** (or **OK**); don't move it to the Bin.
3. Open **System Settings › Privacy & Security** and scroll down to **Security**. Next to the message about CodeDen, choose **Open Anyway**.
4. Open CodeDen again and choose **Open Anyway** in the dialog. Enter your password if asked.

After that CodeDen opens normally. On macOS 14 and earlier you can instead Control-click (or right-click) CodeDen in Applications, choose **Open**, then **Open** again.

**If macOS says "CodeDen is damaged and can't be opened"** (version 0.4.4 and earlier weren't signed at all, which macOS reports this way), don't move it to the Bin. Remove the download flag macOS put on the app instead:

1. Open **Terminal** (in Applications › Utilities).
2. Run this command:

   ```sh
   xattr -dr com.apple.quarantine /Applications/CodeDen.app
   ```

3. Open CodeDen again.

**A macOS app without a Developer ID can't update itself:** macOS only installs updates into an app signed with a Developer ID, so download new versions from the [latest GitHub Release](https://github.com/leonvanzyl/codeden/releases/latest) and drag them over the old one. **Settings › About** says when this applies.

## First launch

The app uses the same data folder as `npx codeden`: `~/.codeden` (or `CODEDEN_HOME`). On launch it:

1. **Attaches** to a CodeDen server that is already running for that folder (for example one you started with `npx codeden`), or
2. **starts its own** server on port 4317 (or any free port if 4317 is taken), which starts the runner as usual.

Then the window opens on the UI, already signed in. A first launch shows the same setup checklist as the browser; it reports Node.js as "built into the app".

The app's server and runner keep running between windows, so they may have started before you installed or fixed a CLI. You don't need to restart anything. **Re-check** on the setup checklist looks again: on Windows it first adds new folders from your user and system `Path`, and it always looks in the installers' own folders, such as `%USERPROFILE%\.local\bin` for the native Claude Code installer. A copy that is found but doesn't run shows as **installed but broken**, with its path. See [Troubleshooting](troubleshooting.md#claude-code-codex-or-opencode-is-installed-but-broken).

## The window and the tray

- **Closing the window** keeps CodeDen running in the tray (Windows, Linux) or menu bar (macOS), so agents, automations and notifications carry on. Click the tray icon (or choose **Open CodeDen**) to bring it back. Turn this off under **Settings > App > Keep running in the tray**.
- **The tray** shows how many agents are running and how many are waiting on you, plus the inbox count, and has **Open the inbox**, the next update step when there is one, and **Quit CodeDen**.
- **Quit** really quits: it closes the window and the server. Like stopping `codeden` with Ctrl+C, the **runner keeps running**, so agents in the middle of a turn finish it, and the next launch picks everything up again. Open session browsers move to the runner's own browser first (see [The session browser](#the-session-browser)). To stop the agents too, run `npx codeden stop` (or stop the sessions first).
- **Badge.** The number of things waiting on you appears on the app icon (the dock on macOS, a dot on the taskbar button on Windows, the launcher on Linux desktops that support it).
- **Notifications** are the system's own (Settings > Notifications > System notifications). Clicking one brings the window to the front on the right page. A burst of updates is one notification that updates in place rather than a stack.
- **Keep awake.** While an agent is running, CodeDen keeps the computer from going to sleep (the screen can still turn off). Settings > App > Keep the computer awake.
- **Open at login** (Windows, macOS): Settings > App > Open at login starts CodeDen in the tray when you log in.
- **Adding a project** uses the system folder picker. "Browse folders in CodeDen instead" opens the in-app browser if you prefer it.
- **Zoom** makes the whole UI larger or smaller in 10% steps, from 50% to 200% (View menu). The keys work even when the menu bar is hidden:

  | Action | Windows, Linux | macOS |
  |---|---|---|
  | Zoom in | Ctrl+= or Ctrl+Shift+= (Ctrl+Plus), Ctrl+Num+ | Cmd+= or Cmd+Shift+=, Cmd+Num+ |
  | Zoom out | Ctrl+- or Ctrl+Shift+-, Ctrl+Num- | Cmd+- or Cmd+Shift+-, Cmd+Num- |
  | Actual size (100%) | Ctrl+0, Ctrl+Num0 | Cmd+0, Cmd+Num0 |

- The window remembers its size, position and zoom (also after a reload or a restart).

### Links

The app registers `codeden://` links:

| Link | Opens |
|---|---|
| `codeden://` | Home |
| `codeden://inbox` | The inbox |
| `codeden://session/<id>` | A session |
| `codeden://project/<id>` | A project |
| `codeden://settings/<section>` | A settings page, e.g. `codeden://settings/about` |

Opening a link while CodeDen runs brings the window to the front on that page; otherwise it starts CodeDen there. Only one copy of the app runs per data folder.

## The session browser

In the desktop app the browser panel is a real browser: each tab of a session's browser is a native browser view laid over the panel, not a streamed picture. Scrolling, text selection, typing (including with an input method), the right-click menu, `<select>` pop-ups and drag and drop all work as in any browser, at full frame rate. Agents drive the same tabs with the same tools, and the **Agent is acting** chip shows while they do.

- **The toolbar** works as with the streamed view: address bar, back, forward, reload, tabs, dev servers, **New tab** and **Close browser**. **⋯ › Inspect** opens DevTools for the page (also F12, or Ctrl+Shift+I; Cmd+Option+I on macOS). The page always has the panel's size, so the device-size presets are only offered for the streamed view.
- **Keys** typed into the page stay in the page, except CodeDen's own shortcuts (the command palette, panel and sidebar toggles, Alt+1 to Alt+6, and the rest with Ctrl/Cmd or Alt), which still reach CodeDen. F5 or Ctrl+R reloads, Alt+Left and Alt+Right go back and forward (Cmd+[ and Cmd+] on macOS).
- **Menus over the page.** A native view is drawn on top of the window, so while a menu, a dialog, the command palette or a tooltip overlaps it, the view steps aside and a still picture of the page takes its place until the menu closes. Notifications move to the bottom left while a native view is on screen.
- **Each session is separate.** Every session has its own cookies and storage, kept in memory and dropped when its browser closes, as in the runner's browser. Pop-ups and links that open a new window become tabs of the same session.
- **What a page may do.** Pages can copy to the clipboard and nothing else: no camera, microphone, location, notifications or devices. They can't open `file://`, `chrome://` or `devtools://` pages. Downloads go to your Downloads folder (a file is never overwritten) and a notification tells you when one finishes.
- **Who gets a native browser.** A session's browser opens on native views when it is opened from the app's window, or by an agent while the app is running. Opened from a plain browser tab or a phone, it opens in the runner's own browser (the streamed view). An open browser keeps its kind until it closes. A phone or browser tab watching a native session sees it streamed, fitted into its screen; it never resizes the page in the app.
- **Quitting the app** moves each open tab of a session to the runner's own browser, at the same address and with its cookies, so agents can carry on. Anything typed into a page and not saved is lost. If the app crashes, the tabs reopen at their last address, without cookies. After you open the app again, those sessions stay on the streamed view; browsers opened from then on are native.
- **Settings › App › Native browser** (on by default) switches native views off for browsers opened from then on; they use the streamed view instead.

## Updates

The desktop app updates itself from GitHub Releases, following **Settings > General > Updates**:

- **Notify me** (default): CodeDen checks on start and every 6 hours (only the release metadata is fetched). The update banner offers the new version with **What's new**, **Update now** and **Later**. **Update now** downloads it with progress, then stops the runner gracefully (as `codeden stop` does), installs the update and starts the new version; running sessions resume where they left off.
- **Install automatically**: new versions download in the background and install when you quit CodeDen (or right away with **Restart now** in the banner, or **Restart to update** in the tray).
- **Off**: no checks.

Notes:

- The npm self-update (`codeden update`, side-by-side versions in `~/.codeden/app`) is off in the desktop app; the app replaces itself instead. If the app attached to a server you started with `npx codeden`, the banner is about that npm install, and the app updates itself on its own (with a notification and the tray menu).
- macOS needs an app signed with a Developer ID to update (see [Unsigned builds](#unsigned-builds)). The Debian package updates through the downloaded `.deb` (it asks for your password); the AppImage replaces itself.
- If an update fails, the banner shows why, with **Retry**. You can always install a newer release by hand over the old one.

## Where things live

| What | Where |
|---|---|
| Your data (database, settings, worktrees, logs) | `~/.codeden` (shared with `npx codeden`; `CODEDEN_HOME` or `--home` to change it) |
| The app's own profile (window state, cookies, cache) | `~/.codeden/desktop` |
| Session browser cookies and storage (native views) | In memory only, per session; gone when the session's browser closes or the app quits (after the hand-off) |
| Downloads from the session browser | Your Downloads folder |
| App logs | `~/.codeden/logs/desktop.log` and `desktop-server.log` (Help > Show Logs) |
| Claude Code support (installed on first use) | `~/.codeden/deps` |
| The app itself | Windows: `%LOCALAPPDATA%\Programs\CodeDen`; macOS: `/Applications/CodeDen.app`; Linux: wherever you keep the AppImage, or `/opt/CodeDen` for the `.deb` |
| Downloaded updates | Windows: `%LOCALAPPDATA%\codeden-updater`; macOS: `~/Library/Caches/codeden-updater`; Linux: `~/.cache/codeden-updater` |

Claude Code support (the Claude Agent SDK) is not part of the app: on first use it is downloaded from the npm registry into `~/.codeden/deps`, checked against its published checksum, without needing npm.

Uninstalling the app leaves `~/.codeden` alone; delete it yourself to remove your data.

## Command line

The app accepts a few options (for example in a shortcut):

```text
CodeDen [--home <dir>] [--port <n>] [--hidden] [codeden://...]
```

`--home` uses another data folder (a separate, independent CodeDen), `--port` picks the port for a server the app starts, and `--hidden` starts in the tray.

## Security

The window shows only the local server's UI: it is sandboxed and isolated from Node.js, the page gets a small, typed bridge for notifications, the badge, the folder picker and links, and every call is checked in the app. Navigation away from the local server is blocked; other links open in your browser. The page may use notifications, the microphone (dictation) and the clipboard, and nothing else. The app never opens a debugging port: the runner reaches a session's native browser views through a separate connection for that session (127.0.0.1 only, a random secret per session, refused for web pages), which sees only that session's tabs and never the CodeDen window. The views are sandboxed, have no access to Node.js or the app's bridge, and use a separate in-memory profile per session, never the window's own (which holds CodeDen's sign-in). Everything else is as described in [Security](security.md): loopback only by default, the per-install token, no telemetry.

## Phones and tablets

**Settings › Network access** works the same in the desktop app as with `npx codeden`: set a password, switch it on, and scan the QR code with your phone. Switching it on or off moves only the server's web listener; the window, the tray and running agents carry on. The app's own window always uses this computer's address and the install token. See [Phones, tablets and network access](remote-access.md).
