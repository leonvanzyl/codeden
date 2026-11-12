/** The part of Electron's `Notification` the notifier uses (a fake in tests). */
export interface NativeNotification {
  on(event: "click" | "close", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface NativeNotificationOptions {
  title: string;
  body: string;
  /** Set when it replaces one still on screen, so an update doesn't sound again. */
  silent: boolean;
}

export interface Notifier {
  show(n: { title: string; body: string; tag?: string }): void;
}

/** Tagged notifications remembered for replacing (the oldest is forgotten, not closed). */
const MAX_TRACKED = 50;

/**
 * Native notifications that honour `tag` like the web's `Notification` (§11.1, §17): a new one
 * with the tag of one still on screen closes it and takes its place, silently. The UI tags a
 * burst of updates grouped into one toast with one tag, so they stay one system notification.
 * A replaced notification no longer answers clicks; the one on screen opens the group's target.
 */
export function createNotifier(
  create: (opts: NativeNotificationOptions) => NativeNotification,
  onClick: (tag: string | undefined) => void,
): Notifier {
  const onScreen = new Map<string, NativeNotification>();
  const current = (tag: string, n: NativeNotification) => onScreen.get(tag) === n;

  return {
    show({ title, body, tag }) {
      const previous = tag === undefined ? undefined : onScreen.get(tag);
      const note = create({ title, body, silent: previous !== undefined });
      if (tag !== undefined) {
        // Re-insert, so the map's order is the order they were last shown.
        onScreen.delete(tag);
        onScreen.set(tag, note);
        while (onScreen.size > MAX_TRACKED) {
          const oldest = onScreen.keys().next().value;
          if (oldest === undefined) break;
          onScreen.delete(oldest);
        }
      }
      note.on("click", () => {
        if (tag === undefined) return onClick(undefined);
        if (!current(tag, note)) return;
        onScreen.delete(tag);
        onClick(tag);
      });
      note.on("close", () => {
        if (tag !== undefined && current(tag, note)) onScreen.delete(tag);
      });
      previous?.close();
      note.show();
    },
  };
}
