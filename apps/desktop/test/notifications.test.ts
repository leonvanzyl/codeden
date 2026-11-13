import { describe, expect, it, vi } from "vitest";
import {
  createNotifier,
  type NativeNotification,
  type NativeNotificationOptions,
} from "../src/main/notifications";

/** Fake native notifications: what was shown, what is still on screen, and clicks on them. */
function fakeSystem() {
  const all: Array<{
    opts: NativeNotificationOptions;
    onScreen: boolean;
    click: () => void;
  }> = [];
  const create = (opts: NativeNotificationOptions): NativeNotification => {
    const listeners: Record<string, Array<() => void>> = { click: [], close: [] };
    const entry = {
      opts,
      onScreen: false,
      click: () => {
        for (const l of listeners.click ?? []) l();
      },
    };
    all.push(entry);
    return {
      on(event, listener) {
        listeners[event]?.push(listener);
      },
      show() {
        entry.onScreen = true;
      },
      close() {
        entry.onScreen = false;
        for (const l of listeners.close ?? []) l();
      },
    };
  };
  return { all, create, onScreen: () => all.filter((n) => n.onScreen) };
}

describe("desktop notifications by tag (§11.1, §17)", () => {
  it("keeps a burst grouped under one tag as one notification on screen", () => {
    const system = fakeSystem();
    const clicked = vi.fn();
    const notifier = createNotifier(system.create, clicked);
    notifier.show({ title: "Run failed: Fix login", body: "boom", tag: "update:a" });
    for (let n = 2; n <= 5; n++) {
      notifier.show({ title: `${n} failures need a look`, body: "Latest: …", tag: "update:a" });
    }
    expect(system.all).toHaveLength(5);
    expect(system.onScreen().map((n) => n.opts.title)).toEqual(["5 failures need a look"]);
    // Only the first one sounds; the replacements update it quietly.
    expect(system.all.map((n) => n.opts.silent)).toEqual([false, true, true, true, true]);
  });

  it("opens the group once, from the notification on screen; replaced ones do nothing", () => {
    const system = fakeSystem();
    const clicked = vi.fn();
    const notifier = createNotifier(system.create, clicked);
    notifier.show({ title: "Run failed: Fix login", body: "", tag: "update:a" });
    notifier.show({ title: "2 failures need a look", body: "", tag: "update:a" });
    system.all[0]?.click();
    expect(clicked).not.toHaveBeenCalled();
    system.all[1]?.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledWith("update:a");
  });

  it("shows different tags side by side and starts afresh after one is closed", () => {
    const system = fakeSystem();
    const clicked = vi.fn();
    const notifier = createNotifier(system.create, clicked);
    notifier.show({ title: "Approval needed", body: "", tag: "inbox:1" });
    notifier.show({ title: "Ready to merge", body: "", tag: "update:b" });
    expect(system.onScreen()).toHaveLength(2);
    // Clicked away: the next one with that tag is new, so it may sound.
    system.all[1]?.click();
    notifier.show({ title: "Ready to merge again", body: "", tag: "update:b" });
    expect(system.all[2]?.opts.silent).toBe(false);
    // Untagged notifications never replace each other and still bring the window up.
    notifier.show({ title: "Untagged", body: "" });
    notifier.show({ title: "Untagged too", body: "" });
    system.all[4]?.click();
    expect(clicked).toHaveBeenLastCalledWith(undefined);
  });
});
