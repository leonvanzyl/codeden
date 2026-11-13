import type { BrowserServerMessage, BrowserTab } from "@codeden/contracts";
import type { BrowserApi, BrowserChannel, BrowserConnection } from "../feature-apis";
import { storefrontFrame } from "./fixtures/images";

const W = 1024;
const H = 640;

/** Render the SVG storefront frame to PNG base64 (frames carry JPEG/PNG only). */
function pngFrame(step: number, url: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/png").split(",")[1] ?? null);
      };
      img.onerror = () => resolve(null);
      img.src = storefrontFrame(step, url);
    } catch {
      resolve(null);
    }
  });
}

/** One shared fake browser per mock client: a storefront dev server the agent is testing. */
function createMockBrowser() {
  let tabs: BrowserTab[] = [
    {
      tabId: "t1",
      url: "http://localhost:5173/products?category=Textiles",
      title: "Products · Hearth & Co.",
      active: true,
    },
  ];
  let step = 0;
  const listeners = new Set<(m: BrowserServerMessage) => void>();
  const emit = (m: BrowserServerMessage) => {
    for (const l of listeners) l(m);
  };
  const active = () => tabs.find((t) => t.active) ?? tabs[0];
  const pushFrame = async () => {
    const tab = active();
    if (!tab) return;
    const data = await pngFrame(step, tab.url);
    if (data)
      emit({ type: "frame", mediaType: "image/png", data, width: W, height: H, tabId: tab.tabId });
  };
  const setTabs = (next: BrowserTab[]) => {
    tabs = next;
    emit({ type: "tabs", tabs });
    void pushFrame();
  };
  return {
    tabs: () => tabs,
    listeners,
    pushFrame,
    tick() {
      step += 1;
      // The fake agent works in bursts: two ticks acting, two idle.
      emit({ type: "agent", acting: step % 4 < 2 });
      void pushFrame();
    },
    navigate(url: string) {
      const tab = active();
      if (!tab) return;
      setTabs(tabs.map((t) => (t === tab ? { ...t, url, title: url } : t)));
    },
    newTab(url = "about:blank") {
      const tab = { tabId: `t${tabs.length + 1}`, url, title: url, active: true };
      setTabs([...tabs.map((t) => ({ ...t, active: false })), tab]);
      return tab;
    },
    activate(tabId: string) {
      setTabs(tabs.map((t) => ({ ...t, active: t.tabId === tabId })));
    },
    closeTab(tabId: string) {
      const rest = tabs.filter((t) => t.tabId !== tabId);
      if (rest.length && !rest.some((t) => t.active))
        rest[0] = { ...(rest[0] as BrowserTab), active: true };
      setTabs(rest);
    },
  };
}

/** The mock client's session browser: tabs, navigation and a live fake screencast. */
export function mockBrowserApi(): BrowserApi {
  const b = createMockBrowser();
  const ok = <T>(v: T) => Promise.resolve(v);
  return {
    openChannel(): BrowserChannel {
      const mine = new Set<(m: BrowserServerMessage) => void>();
      const relay = (m: BrowserServerMessage) => {
        for (const l of mine) l(m);
      };
      b.listeners.add(relay);
      const interval = setInterval(() => b.tick(), 1500);
      setTimeout(() => {
        relay({ type: "state", viewerId: "ui-mock", open: true, watching: true, tabs: b.tabs() });
        void b.pushFrame();
      }, 50);
      return {
        onMessage(l) {
          mine.add(l);
          return () => mine.delete(l);
        },
        onConnection(l: (s: BrowserConnection) => void) {
          l("open");
          return () => {};
        },
        input: () => b.tick(),
        watch: () => {},
        unwatch: () => {},
        open: () => {},
        // The mock storefront has a fixed size; the panel fits it inside.
        viewport: () => {},
        // The mock storefront never opens a dialog.
        dialog: () => true,
        close() {
          clearInterval(interval);
          b.listeners.delete(relay);
          mine.clear();
        },
      };
    },
    open: () => ok({ cdpUrl: null, tabs: b.tabs() }),
    close: () => ok(undefined),
    tabs: () => ok({ open: true, tabs: b.tabs() }),
    newTab: (_id, url) => ok({ tab: b.newTab(url) }),
    closeTab: (_id, tabId) => ok(b.closeTab(tabId)),
    activateTab: (_id, tabId) => ok(b.activate(tabId)),
    navigate: (_id, url) => {
      b.navigate(url);
      return ok({ url, status: 200 });
    },
    history: () => ok({ url: b.tabs()[0]?.url ?? "" }),
    viewport: () => ok(undefined),
    openDevServer: (_id, port, path) =>
      ok({ tab: b.newTab(`http://localhost:${port}${path ?? "/"}`) }),
    devServers: () =>
      ok({
        servers: [
          { port: 5173, pid: 4120, url: "http://localhost:5173" },
          { port: 6006, pid: 4388, url: "http://localhost:6006" },
        ],
      }),
  };
}
