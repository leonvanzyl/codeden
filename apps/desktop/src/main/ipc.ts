import {
  type DesktopInfo,
  DesktopNotification,
  Id,
  type NativeBrowserBounds,
  NativeBrowserShow,
} from "@codeden/contracts";
import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  shell,
} from "electron";
import { z } from "zod";
import { CHANNELS } from "../shared/channels";
import { createNotifier } from "./notifications";
import { externalUrl, isServerUrl } from "./security";

export interface BridgeHost {
  info: () => DesktopInfo;
  /** The server origin the window may call from, null before it loaded. */
  origin: () => string | null;
  window: () => BrowserWindow | null;
  /** Bring the window up (a notification was clicked). */
  showWindow: () => void;
  setBadge: (count: number) => void;
  icon: string;
  log: (message: string) => void;
  /** Native browser views (§17 Phase 2). */
  browser: {
    show(sessionId: string, bounds: NativeBrowserBounds): void;
    hide(sessionId: string): void;
    capture(sessionId: string): Promise<string | null>;
    inspect(sessionId: string): void;
  };
}

const PickFolder = z
  .object({ title: z.string().max(200).optional(), defaultPath: z.string().max(4096).optional() })
  .default({});

/**
 * The main-process side of `window.codedenDesktop` (§17). Calls are accepted only from the
 * CodeDen window showing the server's UI, and every payload is validated.
 */
export function registerBridge(host: BridgeHost): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const origin = host.origin();
    const url = event.senderFrame?.url ?? "";
    const ok = origin !== null && isServerUrl(url, origin);
    if (!ok) host.log(`bridge: ignored a call from ${url || "an unknown frame"}`);
    return ok;
  };

  ipcMain.handle(CHANNELS.info, (event) => (trusted(event) ? host.info() : null));

  ipcMain.handle(CHANNELS.pickFolder, async (event, raw) => {
    if (!trusted(event)) return null;
    const opts = PickFolder.parse(raw ?? {});
    const win = BrowserWindow.fromWebContents(event.sender) ?? host.window();
    const options = {
      title: opts.title ?? "Choose a folder",
      defaultPath: opts.defaultPath,
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // A notification with the tag of one still on screen replaces it (a grouped burst stays one).
  const notifier = createNotifier(
    (opts) =>
      new Notification({ ...opts, icon: process.platform === "darwin" ? undefined : host.icon }),
    (tag) => {
      host.showWindow();
      if (tag) host.window()?.webContents.send(CHANNELS.notificationClick, tag);
    },
  );
  ipcMain.on(CHANNELS.notify, (event, raw) => {
    if (!trusted(event) || !Notification.isSupported()) return;
    const parsed = DesktopNotification.safeParse(raw);
    if (!parsed.success) return;
    notifier.show({
      title: parsed.data.title,
      body: parsed.data.body ?? "",
      tag: parsed.data.tag || undefined,
    });
  });

  ipcMain.on(CHANNELS.openExternal, (event, raw) => {
    if (!trusted(event) || typeof raw !== "string") return;
    const url = externalUrl(raw);
    if (url) void shell.openExternal(url);
  });

  ipcMain.on(CHANNELS.setBadge, (event, raw) => {
    if (!trusted(event)) return;
    const count = z.int().min(0).max(100_000).safeParse(raw);
    if (count.success) host.setBadge(count.data);
  });

  // Native browser views: the UI only places them; tabs and navigation go through the server.
  ipcMain.on(CHANNELS.browserShow, (event, raw) => {
    if (!trusted(event)) return;
    const show = NativeBrowserShow.safeParse(raw);
    if (show.success) host.browser.show(show.data.sessionId, show.data.bounds);
  });
  ipcMain.on(CHANNELS.browserHide, (event, raw) => {
    if (!trusted(event)) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.hide(sessionId.data);
  });
  ipcMain.handle(CHANNELS.browserCapture, (event, raw) => {
    if (!trusted(event)) return null;
    const sessionId = Id.safeParse(raw);
    return sessionId.success ? host.browser.capture(sessionId.data) : null;
  });
  ipcMain.on(CHANNELS.browserInspect, (event, raw) => {
    if (!trusted(event)) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.inspect(sessionId.data);
  });
}
