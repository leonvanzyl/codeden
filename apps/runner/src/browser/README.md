# Runner browser engine

Each CodeDen session has one browser (DESIGN §12.2), on one of two engines:

- **`runner`**: an isolated `BrowserContext` in the one Chromium the runner launches, so
  cookies, storage and tabs never cross sessions. People see it through a CDP screencast.
- **`native`**: the desktop app's own browser views for that session (§17 Phase 2), reached
  through the app's per-session CDP relay. People see the real view in the desktop panel;
  phones and browser tabs see a screencast of it.

Agents drive the same tabs through the same small set of primitives on both: everything goes
through CDP, and `BrowserSession` doesn't care which engine is underneath.

## Modules

| File | Concern |
|---|---|
| `launcher.ts` | Finds and launches installed Edge/Chrome via playwright-core `channel` (Edge first on Windows, Chrome first elsewhere), optional consented fallback to a downloaded Chromium, CDP endpoint on `127.0.0.1:<free port>`, browser pid via `SystemInfo.getProcessInfo` |
| `manager.ts` | `BrowserManager`: lazy launch, one browser per session on either engine, `handoff` to the runner's Chromium, reopening tabs when a relay drops, `openDevServer(port)`, shutdown that kills the browser process tree (native sessions only disconnect) |
| `relay.ts` | `connectRelay`: playwright-core `connectOverCDP` to the desktop app's relay (secret in a header); hand-off cookies for playwright |
| `session.ts` | `BrowserSession`: tabs (`t1`, `t2`, ...; popups are adopted), active tab, navigate/back/forward/reload, viewport emulation on every tab (runner engine only), input forwarding, `browser.tabs` stream updates with the engine |
| `viewport.ts` | Viewport policy: clamps (`fitViewport`), frame pixel size (`framePixels`), `Emulation.setDeviceMetricsOverride` parameters |
| `screencast.ts` | `Page.startScreencast` on the active tab, JPEG frames sized to the viewport's device pixels as `browser.frame` stream data with metadata, throttled by delaying `Page.screencastFrameAck`, paused when the last viewer leaves, follows tab switches, restarts on resize |
| `input.ts` | Panel mouse/keyboard -> `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`, coordinates mapped from the displayed frame onto the viewport the frame showed |
| `agent.ts` | Agent primitives: aria snapshot with refs, click/type by ref (or type at the focused element), press, screenshot (viewport, full page, element) to a path, guarded evaluate, wait for selector/text/network idle; `withRef`, which fails fast on a ref missing from the latest snapshot |
| `pointer.ts` | Agent pointer actions at coordinates (`browser.mouse`): click, hover, drag, scroll on Playwright's mouse, with modifiers held, points checked against the current viewport, the button and keys always released, and scrolls waited on until the page settles |
| `forms.ts` | Agent form controls the refs can't reach (`browser.select`, `browser.upload`, computer use step 2): options of a native `<select>` by label or value through `selectOption`, checked first so mistakes fail at once; files set on a file input with `setInputFiles`, or through the file chooser that clicking a button or drop zone opens (`filechooser`, waited on for 3 s) |
| `logs.ts` | Bounded console and network logs per session (ring buffers, `since` paging) |
| `handlers.ts` | `createBrowserCommandHandlers({ manager })`: one handler per `browser.*` runner command |

## Viewport: the page follows the panel

The panel is a browser surface, not a preview: the page is laid out at the panel's own size
and pixel density, and the frames are drawn 1:1, edge to edge.

1. **The panel measures itself.** A `ResizeObserver` on the panel's content box (below the
   toolbar) reports its CSS width, height and `devicePixelRatio` over `/ws/browser` as a
   `viewport` message: the first size at once, then debounced (120 ms after the resize
   settles, at least every 400 ms during a long drag). DPR changes (another screen, zoom)
   re-report.
2. **One viewer owns the size** (`apps/server/src/realtime/browser-viewport.ts`). The first
   viewer to report owns it. Another viewer takes it over by *claiming*: its window gains
   focus, the panel is pressed, or a fixed size is picked. The page follows the owner's
   reports; the others are remembered. When the owner leaves, the viewer that claimed most
   recently (else the one that reported first) takes over. So opening the panel on a phone
   doesn't resize the page under a desktop viewer, but using the phone does. Each viewer is
   told the applied size and whether it is `mine`: the owner stretches frames over the panel
   (`object-fit: fill`), others fit them inside (`contain`).
3. **The runner emulates it** (`session.setViewport`). Contexts are created with
   `viewport: null`, so one `Emulation.setDeviceMetricsOverride` per tab, on the session's own
   CDP session, owns size and scale (Playwright fixes the scale factor per context). New tabs
   and popups get the current metrics before they are activated; a reopened session browser
   starts at its last size.
4. **The screencast follows.** `maxWidth`/`maxHeight` are the viewport's device pixels, and a
   running screencast restarts on resize. The last frame stays on the panel's canvas,
   stretched, until the first new one arrives: no blank flash.

**Clamps** (`viewport.ts`):

| Limit | Value | Why |
|---|---|---|
| Min CSS size | 320 x 240 | The narrowest layout sites still design for; a smaller panel shows the page scaled down a little instead |
| Max CSS size | 3840 x 2400 | 4K-class panels; bigger is scaled in the panel |
| Device scale | 1 to 2 | Sharp on 1.25x/1.5x/2x screens; 3x phones would cost 2.25x the pixels for little visible gain |
| Frame pixels | at most 2560 x 1600, never below the CSS size | Bounds JPEG encode time and frame size; the scale drops (never below 1) to fit. Frames are never scaled below one pixel per CSS pixel, not for the budget and not for a viewer's `maxWidth`/`maxHeight` (see below) |

**Why the browser runs at 2x.** Screencast frames are captured at the browser's *real*
device scale, not the emulated one (measured: emulating 2x on a 1x browser still yields CSS-
sized frames). The launcher passes `--force-device-scale-factor=2` (the max we emulate) and
`maxWidth`/`maxHeight` scale frames down to each viewport's device pixels, which also
supersamples 1x and 1.25x viewers.

**Frames:** JPEG quality 75 (60 visibly smeared small text at device pixels), at most 20 fps,
only on change, throttled by delaying acks (held-back acks are sent when the screencast
stops); slow sockets skip frames server-side. Because Chromium only sends frames on change,
a still page could leave a viewer with nothing to draw: a new viewer gets the last frame, a
(re)started screencast that sends nothing within 1 s gets a still from
`Page.captureScreenshot`, and a panel that still has no frame after 3 s re-sends `watch`.

**The CSS-size floor (macOS).** Asked for frames smaller than the page's CSS size, Chromium on
macOS misbehaves. Measured on CI: a 1280x800 page capped to 640x400 sent no frames for 750 ms
of page changes, and the frames it did send reported 640x400 as the viewport, which would put
clicks at half the distance. Frames at or above the CSS size are fine there: a 460x712 page at
2x capped to 460x712 sends 460x712 frames with correct metadata. So `startParams` never asks
for less than the CSS viewport, on every platform.

**Input:** the panel maps pointer positions from where the frame is drawn (the whole box, or
the letterboxed rectangle when fitted) into frame pixels and sends the frame's own viewport
(`viewportWidth`/`viewportHeight` from its metadata), so clicks stay exact while a resize is
in flight. Wheel deltas become page CSS pixels (lines are 40 px, pages 87.5% of the
viewport, scaled by how big the page is drawn), are summed per animation frame, and are
capped at 1200 px per event. There is no take-over mode: human input always goes to the
page, also while an agent acts (the panel shows "Agent is acting" from the server's
`agent` activity signal: on while an agent `browser_*` tool runs, plus 2.5 s).

**Agents** are unaffected: snapshots, ref clicks and typing don't depend on the size, and
`browser_screenshot` captures the current viewport in CSS pixels (`scale: "css"`), so a
HiDPI viewer doesn't double the image an agent gets. With no viewer, the page keeps its last
size (default 1280x800).

**Coordinates** (`browser.mouse`, computer use step 1) are the same CSS pixels: a point read
off a viewport screenshot goes to Playwright's mouse unchanged, which sends
`Input.dispatchMouseEvent` in CSS pixels whatever the emulated scale. Points outside the
viewport are refused (`out_of_bounds`, naming the size); on native views the target tab's own
view is measured fresh for each action (a view in the background can differ from the shown
one, and measuring it leaves the session's viewport alone). If that view can't be measured
(busy in a script past the 2 s limit, or navigating), the action fails with a retryable
`viewport_unavailable` and nothing is sent: it never borrows another view's size. Viewer input
keeps the tolerant path, which uses the last known size of the shown view. A drag presses at the start, moves
to the end in about one step per 20 px (5 to 50) so drag thresholds see motion, and releases.
Playwright counts a button or key as held before its press is dispatched, so a failed step
(the press included) still releases every button and key the action tried to press, keeping
the original error. A scroll moves the pointer to the point first, so the wheel reaches the
scroller under it, then waits until no `scroll` event came for 100 ms (at most about 1 s), so a
screenshot right after shows the result.

## Select menus and file uploads (computer use, step 2)

A native `<select>` shows in the snapshot as a `combobox` (a multiple select as a `listbox`)
with its options listed, but the menu opens in a popup the browser draws itself: no ref, no
screencast pixels. A file input shows as a `button`; clicking it opens a file chooser that
nothing answers (headless Chromium cancels it, a native view shows the desktop app's picker).

- **`browser.select`** reads the element once (a `<label>` is followed to its control): its tag,
  `multiple`, disabled state and options. Each value names an option by its label (what the
  snapshot shows) or else its value, exactly. Not a `<select>`, no such option (the error lists
  them), several values for a single select, or a disabled select or option fail at once,
  instead of `selectOption` waiting out the action timeout; an option's ref is pointed to its
  menu's ref. The matched options are selected by index, so the page gets the same `input` and
  `change` events a person's choice fires, and the result names the selected options. They are
  read back (a change handler may change them again), but the read never decides the outcome:
  a sort-by or language menu whose change navigates the page, or a select the page re-renders,
  is gone by then. When the ref no longer resolves (a navigated document has no refs) or the
  read takes over 1 s, the result is the options that were chosen, with `detached: true`.
- **`browser.upload`** takes absolute paths of files on this machine (the server has already
  checked them against the session's folders and the secrets rule). On a file input (also a
  hidden one, or a label for one) it calls `setInputFiles`. Anything else (a "Browse" button, a
  drop zone) is clicked while waiting up to 3 s for the `filechooser` event, and the chooser gets
  the files; no chooser fails with `no_file_chooser`. Several files go only where the input or
  chooser takes multiple. Playwright intercepts file choosers only while a `filechooser` listener
  exists, so interception is on just while an upload waits: a person clicking a file input in a
  native view still gets the app's own picker. Choosers opened by `browser.click`,
  `browser.mouse` or a key press are not caught.
- Both run in `dialogs.race`, so an `alert` from a change handler comes back as `dialog`. Both are
  plain Playwright on CDP (`DOM.setFileInputFiles`, `Page.setInterceptFileChooserDialog`), which
  the desktop relay forwards like any page-level call, so they work on either engine. Over
  `connectOverCDP` Playwright passes the paths to the browser as they are, so the browser must
  share the runner's disk: the runner's Chromium does, and so do native views (the relay is on
  127.0.0.1).

## Native engine: the desktop app's views (§17 Phase 2)

`browser.open` with a `relay` (`ws://127.0.0.1:<port>/cdp/<sessionId>` plus a secret) backs a
session that has no browser yet with the desktop app's native views. The server sends one when
the desktop app is connected, the setting is on, and the desktop window or an agent opens the
browser.

- **Connection.** `connectOverCDP(url, { headers: { "x-codeden-relay-secret": secret } })`. The
  relay looks like a browser whose only context holds that session's views, so
  `browser.contexts()[0]` is the session's context and nothing else is reachable: not other
  sessions, not the CodeDen window. Tabs the app already has (the runner reconnected) are
  adopted as tabs.
- **Tabs** are created and closed by the app: `context.newPage()` and `page.close()` become
  `Target.createTarget` / `Target.closeTarget`, which the relay turns into new and closed views.
  `activate` sends `Page.bringToFront`, which shows that view in the panel. Popups opened by a
  page come in as tabs with their opener.
- **No viewport emulation.** A native view is exactly as big as the desktop panel. `setViewport`
  measures it and `browser.viewport` answers with `fixed: true`, so the server tells every
  viewer to fit the frames instead of claiming the size. Screencast frames are only capped
  (2560x1600 device pixels), never sized to a viewer. Pointer input from those viewers is mapped
  against the view's measured CSS size (re-measured at most once a second), never the frame
  metadata, whose units follow the platform's scale handling (DIPs on HiDPI macOS).
- **Everything else is unchanged**: aria snapshots and refs, click/type/press, pointer actions at
  coordinates, screenshots, console and network logs, evaluate, waits, the screencast for phones
  and input from them.
  Refs in native views may carry a frame prefix (`f1e5`); they work like any other ref.
- **Closing.** `browser.close` (or the session stopping) closes the views. Stopping the runner
  only disconnects: the views stay in the app, and the next `browser.open` with the relay
  adopts them.
- **Hand-off.** `browser.handoff` (the app is quitting) drops the relay connection without
  closing the views, creates a runner context, adds the cookies (one at a time, so a cookie
  Chromium refuses doesn't cost the others; `SameSite=None` without `Secure` falls back to the
  default) and reopens each tab at its URL, with the active one active. Page state that lived
  only in the views (unsaved form input, scroll position) is lost.
- **A relay that just drops** (the app crashed, or quit with no server to hand off to) reopens
  the tabs it last had in the runner's Chromium, without cookies. Playwright reports a dropped
  connection as every page closing first, so native tab closes settle for 100 ms before they
  count; a disconnect in that window keeps the tab list.

Tests: `test/browser-native.test.ts` uses a second Chromium's CDP endpoint as a stand-in for
the relay (the relay itself is tested in `apps/desktop/test`).

## Spike: Playwright MCP over CDP vs our own primitives (DESIGN §20, spike 4)

**Decision: use our own primitives on playwright-core. Do not attach Playwright MCP.**

### What was tested

On Windows 11 with Edge 156, `@playwright/mcp@0.0.84`, playwright-core 1.64.1. The runner
launched Edge with a remote-debugging port, created two session contexts (A and B, one
tab each, different cookies), then:

1. Started two Playwright MCP servers with `--cdp-endpoint <our endpoint>` (stdio), one
   per "session".
2. Started one in-process with `createConnection(config, () => contextB)`, the
   programmatic way to hand it a single context.

### Results

- **`--cdp-endpoint`: no confinement.** Each MCP instance listed the tabs of *every*
  context (`0: page-B`, `1: page-A`) and its "current" tab was whichever it found first
  (session B for both instances). `browser_tabs select` plus `browser_navigate` from the
  instance meant for one session navigated the other session's tab. There is no option to
  pin an instance to a context or target. It also writes snapshot files into its working
  directory (`.playwright-mcp/`).
- **In-process `contextGetter`: partial confinement only.** Listing and snapshots stayed
  inside context B, but `browser_tabs` with `isolatedContext` created a new context the
  runner does not manage (no screencast, no isolation bookkeeping), and
  `browser_run_code_unsafe` reached `page.context().browser().contexts()`, i.e. every
  session's pages. It also means bundling `@playwright/mcp` with its own pinned
  pre-release Playwright next to ours and following a 25-tool surface that changes between
  releases.

### Why our own primitives

- Hard isolation: every handler resolves `sessionId -> BrowserSession -> its context`; no
  command can name another session's tab or reach the `Browser` object.
- Same refs and the same mechanics (`page.ariaSnapshot({ mode: "ai" })`,
  `page.getByRef`) that Playwright MCP uses, so agent ergonomics match.
- Humans and agents share the exact tabs the screencast shows; tab changes stream to the
  panel.
- One dependency (playwright-core), no extra process per session, no files written as a
  side effect.

### Screencast latency

Measured on the runner side (before the WebSocket hop to the panel): DOM change to emitted
frame median 6 ms, p90 10 ms at the default 15 fps cap, ~8 KB per 1280x800 JPEG frame
(quality 60). Launch plus first context: ~330 ms. The panel-side hop is not measured yet
(the server/UI wiring is not in this module).

## Notes

- Element refs (`e2`, `f1e3`) come from the latest snapshot of a tab; unchanged elements
  keep their refs across snapshots, a changed element (for example a new accessible name)
  gets a new one. Actions on a missing ref fail fast with "take a new snapshot".
- `evaluate` accepts an expression or function source (functions are called). It is
  CSP-safe, times out (5 s), caps the JSON result (20,000 chars) and can be disabled with
  `new BrowserManager({ evaluate: { enabled: false } })`.
- Navigation refuses `edge://`, `chrome://`, `devtools://` and `javascript:` URLs.
- Shutdown closes every context, closes the browser, then `killTree`s the browser pid if
  anything survived.
