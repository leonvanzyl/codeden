import { describe, expect, it } from "vitest";
import { Settings } from "../src";

/** Parse, serialize to JSON and parse again; the result must be stable. */
function roundTrip(value: unknown): Settings {
  const first = Settings.parse(value);
  const second = Settings.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe("notification settings", () => {
  it("turns the attention chime on by default", () => {
    expect(Settings.parse({}).notifications.sound).toBe(true);
  });

  it("reads settings files saved before the sound switch and categories existed", () => {
    const s = roundTrip({ notifications: { toasts: false, browser: true } });
    expect(s.notifications).toEqual({
      toasts: false,
      browser: true,
      sound: true,
      categories: { needs_you: true, failure: true, factory: false, automation: true },
    });
  });

  it("keeps factory activity quiet by default and round-trips a category switch", () => {
    expect(Settings.parse({}).notifications.categories.factory).toBe(false);
    const s = roundTrip({ notifications: { categories: { factory: true, automation: false } } });
    expect(s.notifications.categories).toEqual({
      needs_you: true,
      failure: true,
      factory: true,
      automation: false,
    });
  });

  it("round-trips the sound switch when turned off", () => {
    const s = roundTrip({ notifications: { sound: false } });
    expect(s.notifications.sound).toBe(false);
    expect(s.notifications.toasts).toBe(true);
  });

  it("rejects a non-boolean sound value", () => {
    expect(Settings.safeParse({ notifications: { sound: "loud" } }).success).toBe(false);
  });
});
