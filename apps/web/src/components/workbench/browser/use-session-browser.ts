import {
  type BrowserDialog,
  type BrowserDialogClosed,
  type BrowserEngine,
  type BrowserServerMessage,
  type BrowserTab,
  DIALOG_TIMEOUT_MS,
} from "@codeden/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiRequestError, useClient } from "@/lib/api";
import type { BrowserChannel, BrowserConnection } from "@/lib/api/feature-apis";

export type FrameMessage = Extract<BrowserServerMessage, { type: "frame" }>;
export type AppliedViewport = Omit<Extract<BrowserServerMessage, { type: "viewport" }>, "type">;

/** Page dialogs waiting for an answer; `version` changes with every update. */
export interface PageDialogs {
  open: BrowserDialog[];
  version: number;
}

/** Tell the user about a dialog that closed without them: the agent or the timeout answered. */
function noteClosed(closed: BrowserDialogClosed): void {
  const what = closed.type === "beforeunload" ? '"Leave this page?"' : `a ${closed.type}`;
  if (closed.by === "timeout") {
    const minutes = Math.round(DIALOG_TIMEOUT_MS / 60_000);
    toast(`Dismissed ${what} nobody answered`, {
      description: `${closed.message || "The page"} waited ${minutes} minutes.`,
    });
  } else if (closed.by === "agent") {
    toast(`The agent ${closed.accepted ? "accepted" : "dismissed"} ${what}`, {
      description: closed.message || undefined,
    });
  }
}

export interface SessionBrowser {
  connection: BrowserConnection;
  /** Null until the server reported the browser's state. */
  open: boolean | null;
  tabs: BrowserTab[];
  activeTab: BrowserTab | undefined;
  /** What backs the open browser: native views in the desktop app, or the runner's Chromium. */
  engine: BrowserEngine | null;
  /** The page's viewport, and whether it follows this panel (`mine`). Null until known. */
  viewport: AppliedViewport | null;
  /** An agent is driving the browser right now (or was a moment ago). */
  agentActing: boolean;
  /** The page dialogs (alert, confirm, prompt) waiting for an answer: the page is paused. */
  dialogs: PageDialogs;
  /** Subscribe to screencast frames (kept out of React state). */
  onFrame(listener: (frame: FrameMessage) => void): () => void;
  channel: BrowserChannel | null;
  /** Run a browser command; `409 browser_not_open` flips the panel to its open screen. */
  run<T>(label: string, action: () => Promise<T>): Promise<T | undefined>;
  /** Open the browser (optionally at a URL) and start watching. */
  openBrowser(url?: string): Promise<void>;
  closeBrowser(): Promise<void>;
}

export function isBrowserNotOpen(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "browser_not_open";
}

/**
 * Live state of a session's browser (§12.2): one `/ws/browser` viewer socket for frames,
 * tabs and open/close state, plus the REST commands, with `409 browser_not_open` handled.
 * `native`: this panel can show native views (the desktop app, §17 Phase 2), so opens prefer
 * them and frames only come for a browser on the runner's Chromium.
 */
export function useSessionBrowser(sessionId: string, native = false): SessionBrowser {
  const client = useClient();
  const [channel, setChannel] = useState<BrowserChannel | null>(null);
  const [connection, setConnection] = useState<BrowserConnection>("connecting");
  const [open, setOpen] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [engine, setEngine] = useState<BrowserEngine | null>(null);
  const [viewport, setViewport] = useState<AppliedViewport | null>(null);
  const [agentActing, setAgentActing] = useState(false);
  const [dialogs, setDialogs] = useState<PageDialogs>({ open: [], version: 0 });
  const frameListeners = useRef(new Set<(f: FrameMessage) => void>());
  /** The newest frame, replayed to new listeners (it can arrive before the canvas mounts). */
  const lastFrame = useRef<FrameMessage | null>(null);
  const [generation, setGeneration] = useState(0);
  const onFrame = useCallback((listener: (f: FrameMessage) => void) => {
    frameListeners.current.add(listener);
    if (lastFrame.current) listener(lastFrame.current);
    return () => {
      frameListeners.current.delete(listener);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` reconnects after close.
  useEffect(() => {
    // Frame size and quality follow the panel's viewport (runner defaults).
    const ch = client.browser.openChannel(sessionId, native ? { native } : undefined);
    setChannel(ch);
    setOpen(null);
    setEngine(null);
    setViewport(null);
    setAgentActing(false);
    setDialogs((d) => ({ open: [], version: d.version + 1 }));
    lastFrame.current = null;
    const offConn = ch.onConnection(setConnection);
    const offMsg = ch.onMessage((msg) => {
      if (msg.type === "state") {
        setOpen(msg.open);
        setTabs(msg.tabs);
        setEngine(msg.open ? (msg.engine ?? "runner") : null);
        if (!msg.open) {
          setAgentActing(false);
          setDialogs((d) => ({ open: [], version: d.version + 1 }));
        }
      } else if (msg.type === "dialogs") {
        setDialogs((d) => ({ open: msg.dialogs, version: d.version + 1 }));
        if (msg.closed) noteClosed(msg.closed);
      } else if (msg.type === "viewport") {
        const { type: _t, ...applied } = msg;
        setViewport(applied);
      } else if (msg.type === "agent") {
        setAgentActing(msg.acting);
      } else if (msg.type === "tabs") {
        if (msg.tabs.length === 0) {
          // The browser closed (agent, session stop or another viewer): start a fresh viewer
          // that waits for the next open instead of a stale screencast registration.
          setOpen(false);
          setTabs([]);
          setGeneration((g) => g + 1);
          return;
        }
        setOpen(true);
        setTabs(msg.tabs);
        if (msg.engine) setEngine(msg.engine);
      } else if (msg.type === "frame") {
        lastFrame.current = msg;
        for (const l of frameListeners.current) l(msg);
      } else if (msg.code === "browser_not_open") {
        setOpen(false);
      } else {
        toast.error("Browser", { description: msg.message });
      }
    });
    return () => {
      offConn();
      offMsg();
      ch.close();
      setChannel(null);
    };
  }, [client, sessionId, generation, native]);

  return useMemo(() => {
    const run = async <T>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        if (isBrowserNotOpen(error)) setOpen(false);
        else
          toast.error(label, {
            description: error instanceof Error ? error.message : String(error),
          });
        return undefined;
      }
    };
    return {
      connection,
      open,
      tabs,
      activeTab: tabs.find((t) => t.active) ?? tabs[0],
      engine,
      viewport,
      agentActing,
      dialogs,
      channel,
      onFrame,
      run,
      async openBrowser(url) {
        // Over the viewer socket, so opening and watching happen together server-side.
        if (channel) return channel.open(url);
        const res = await run("Couldn't open the browser", () =>
          client.browser.open(sessionId, url, native || undefined),
        );
        if (res) setTabs(res.tabs);
      },
      async closeBrowser() {
        await run("Couldn't close the browser", () => client.browser.close(sessionId));
        setOpen(false);
        setTabs([]);
        // A fresh viewer socket waits for the next open (by you or the agent).
        setGeneration((g) => g + 1);
      },
    } satisfies SessionBrowser;
  }, [
    client,
    sessionId,
    native,
    channel,
    connection,
    open,
    tabs,
    engine,
    viewport,
    agentActing,
    dialogs,
    onFrame,
  ]);
}
