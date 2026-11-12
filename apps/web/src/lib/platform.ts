import type { CodedenDesktopApi, CodedenDesktopBrowserApi } from "@codeden/contracts";
import { copyText } from "./clipboard";
import { createDesktopPlatform } from "./platform-desktop";

/**
 * PlatformBridge (§13): every platform feature the UI uses goes through this interface.
 * The web implementation runs in any browser; the desktop app (§17) exposes
 * `window.codedenDesktop` and gets its own implementation. Features are detected through
 * `capabilities`, never by asking which shell we're in.
 */
export interface PlatformBridge {
  readonly capabilities: {
    notifications: boolean;
    badge: boolean;
    clipboardImages: boolean;
    /** A native folder picker that returns real paths (`pickFolder`). */
    folderPicker: boolean;
    /** OS integration settings: launch at login, close to tray, keep awake (Settings > App). */
    osIntegration: boolean;
    /** Session browsers can show as native views over the panel (`nativeBrowser`). */
    nativeBrowser: boolean;
  };
  /** Places the desktop app's native browser views (§17 Phase 2); null elsewhere. */
  readonly nativeBrowser: CodedenDesktopBrowserApi | null;
  notificationPermission(): NotificationPermission | "unsupported";
  requestNotificationPermission(): Promise<NotificationPermission | "unsupported">;
  notify(title: string, opts?: { body?: string; tag?: string; onClick?: () => void }): void;
  openExternal(url: string): void;
  /** Unread count on the app icon (or the tab title as a fallback). */
  setBadge(count: number): void;
  /** Copies text, also on insecure origins (phones on the LAN); false when it failed. Never rejects. */
  writeClipboard(text: string): Promise<boolean>;
  readClipboardImage(): Promise<Blob | null>;
  isFocused(): boolean;
  /** Native folder picker (when `capabilities.folderPicker`); null when cancelled or absent. */
  pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Routes opened from outside the UI (`codeden://` links); returns the unsubscribe. */
  onNavigate(listener: (path: string) => void): () => void;
  /** Launch at login is possible on this OS (only meaningful with `osIntegration`). */
  launchAtLoginSupported(): Promise<boolean>;
}

const baseTitle = typeof document !== "undefined" ? document.title : "CodeDen";

type BadgeNavigator = Navigator & {
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function createWebPlatform(): PlatformBridge {
  const hasNotifications = typeof window !== "undefined" && "Notification" in window;
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as
    | BadgeNavigator
    | undefined;
  return {
    capabilities: {
      notifications: hasNotifications,
      badge: Boolean(nav?.setAppBadge),
      clipboardImages: Boolean(nav?.clipboard && "read" in nav.clipboard),
      // Browsers can't return real paths; the server-side picker is used instead (§13).
      folderPicker: false,
      osIntegration: false,
      nativeBrowser: false,
    },
    nativeBrowser: null,
    notificationPermission: () => (hasNotifications ? Notification.permission : "unsupported"),
    async requestNotificationPermission() {
      if (!hasNotifications) return "unsupported";
      return Notification.requestPermission();
    },
    notify(title, opts) {
      if (!hasNotifications || Notification.permission !== "granted") return;
      const n = new Notification(title, { body: opts?.body, tag: opts?.tag, icon: "/favicon.svg" });
      n.onclick = () => {
        window.focus();
        opts?.onClick?.();
        n.close();
      };
    },
    openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    setBadge(count) {
      document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
      if (nav?.setAppBadge) void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.());
    },
    writeClipboard: (text) => copyText(text),
    async readClipboardImage() {
      if (!nav?.clipboard || !("read" in nav.clipboard)) return null;
      const items = await nav.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) return item.getType(type);
      }
      return null;
    },
    isFocused: () => document.hasFocus() && document.visibilityState === "visible",
    pickFolder: async () => null,
    onNavigate: () => () => {},
    launchAtLoginSupported: async () => false,
  };
}

/** The desktop bridge when the desktop app's preload exposed one, else the web bridge. */
export function selectPlatform(
  target: { codedenDesktop?: CodedenDesktopApi } | undefined,
): PlatformBridge {
  const web = createWebPlatform();
  return target?.codedenDesktop ? createDesktopPlatform(target.codedenDesktop, web) : web;
}

export const platform: PlatformBridge = selectPlatform(
  typeof window !== "undefined" ? (window as { codedenDesktop?: CodedenDesktopApi }) : undefined,
);
