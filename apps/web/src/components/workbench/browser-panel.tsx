import type { BrowserInput } from "@codeden/contracts";
import { Globe, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { BrowserCanvas } from "./browser/browser-canvas";
import { BrowserToolbar, DevServerMenu } from "./browser/browser-toolbar";
import { NativeBrowserView } from "./browser/native-browser-view";
import { PageDialog } from "./browser/page-dialog";
import { usePanelViewport, type ViewportMode } from "./browser/use-panel-viewport";
import { type SessionBrowser, useSessionBrowser } from "./browser/use-session-browser";

/**
 * The browser the agents drive (§12.2). In the desktop app it is a real browser view laid over
 * the panel (§17 Phase 2); elsewhere, and for a browser on the runner's Chromium, it is the
 * screencast, edge to edge. Either way the page is laid out at the panel's own size, and clicks,
 * keys and scrolling go straight to it.
 */
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  const nativeCapable = platform.capabilities.nativeBrowser;
  const browser = useSessionBrowser(sessionId, nativeCapable);
  const native = nativeCapable && browser.engine === "native";
  const [mode, setMode] = useState<ViewportMode>("fit");
  const channel = browser.channel;
  const onInput = useCallback((input: BrowserInput) => channel?.input(input), [channel]);
  // Re-registering as a viewer makes the runner send its current picture.
  const onStall = useCallback(() => channel?.watch(), [channel]);
  // A native view has the panel's size already; only the screencast reports one.
  const measure = usePanelViewport(native ? null : channel, mode, browser.viewport?.mine);
  // The desktop window starts without frames; a browser on the runner's Chromium needs them.
  const needsFrames = nativeCapable && browser.open === true && browser.engine === "runner";
  useEffect(() => {
    if (needsFrames) channel?.watch();
  }, [needsFrames, channel]);
  // A page dialog pauses its page: show the active tab's first, else any tab's.
  const activeId = browser.activeTab?.tabId;
  const dialog = browser.dialogs.open.find((d) => d.tabId === activeId) ?? browser.dialogs.open[0];

  if (browser.open === false) return <ClosedState sessionId={sessionId} browser={browser} />;
  if (browser.open === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {browser.connection === "closed"
          ? "Reconnecting to the session browser…"
          : "Connecting to the session browser…"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="browser-panel">
      <BrowserToolbar
        sessionId={sessionId}
        browser={browser}
        native={native}
        viewportMode={mode}
        onViewportMode={setMode}
      />
      <BrowserTabs sessionId={sessionId} browser={browser} />
      <div
        ref={measure}
        data-testid="browser-viewport"
        data-engine={browser.engine ?? undefined}
        data-viewport={
          browser.viewport
            ? `${browser.viewport.width}x${browser.viewport.height}@${browser.viewport.deviceScaleFactor}`
            : undefined
        }
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
      >
        {native ? (
          <NativeBrowserView
            sessionId={sessionId}
            title={browser.activeTab?.title || "Session browser"}
            // The view paints over everything: it steps aside (a still of the page stays) so the
            // dialog shows.
            covered={dialog !== undefined}
          />
        ) : (
          <BrowserCanvas
            onFrame={browser.onFrame}
            onInput={onInput}
            onStall={onStall}
            // Fill only when the page follows this panel; a preset or another viewer's size is
            // fitted inside instead of stretched.
            fit={mode === "fit" && browser.viewport?.mine ? "fill" : "contain"}
            title={browser.activeTab?.title || "Session browser"}
          />
        )}
        {dialog && (
          <PageDialog
            // A fresh card for every update, so an answered one never answers the next.
            key={`${browser.dialogs.version}:${dialog.tabId}`}
            dialog={dialog}
            tab={browser.tabs.find((t) => t.tabId === dialog.tabId)}
            active={dialog.tabId === activeId}
            onAnswer={(accept, text) => channel?.dialog(dialog.tabId, accept, text)}
          />
        )}
      </div>
    </div>
  );
}

function BrowserTabs({ sessionId, browser }: { sessionId: string; browser: SessionBrowser }) {
  const client = useClient();
  if (browser.tabs.length < 2) return null;
  return (
    <div
      className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2 scroll-thin"
      role="tablist"
      aria-label="Browser tabs"
    >
      {browser.tabs.map((t) => (
        <div
          key={t.tabId}
          className={cn(
            "group flex h-7 max-w-44 min-w-0 items-center gap-1 rounded-t-md border border-b-0 px-2 text-2xs",
            t.active
              ? "border-border bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent/50",
          )}
        >
          <button
            type="button"
            role="tab"
            aria-selected={t.active}
            onClick={() =>
              void browser.run("Couldn't switch tabs", () =>
                client.browser.activateTab(sessionId, t.tabId),
              )
            }
            className="min-w-0 flex-1 truncate text-left"
            title={t.url}
          >
            {t.title || t.url}
          </button>
          <button
            type="button"
            aria-label={`Close ${t.title || t.url}`}
            onClick={() =>
              void browser.run("Couldn't close the tab", () =>
                client.browser.closeTab(sessionId, t.tabId),
              )
            }
            className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent touch:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ClosedState({ sessionId, browser }: { sessionId: string; browser: SessionBrowser }) {
  return (
    <div className="flex h-full items-center justify-center" data-testid="browser-closed">
      <EmptyState
        icon={<Globe />}
        title="The session browser is closed"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void browser.openBrowser()}>
              <Globe /> Open browser
            </Button>
            <DevServerMenu sessionId={sessionId} browser={browser} variant="button" />
          </div>
        }
      >
        It opens on its own when the agent uses a browser tool. Open it yourself to look at a dev
        server, and the agent will see the same page.
      </EmptyState>
    </div>
  );
}
