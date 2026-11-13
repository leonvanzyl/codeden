import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src";
import type { EventStore } from "../src/events/store";
import {
  FILE_RESET_NOTICES,
  fileResetInboxItem,
  reportFileReset,
} from "../src/services/file-reset-notice";
import { SettingsStore } from "../src/settings-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Copies CodeDen kept of a settings file it could not use. */
function backups(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("settings.json.invalid-"));
}

const backupText = () => readFileSync(join(dir, backups()[0] as string), "utf8");
const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as Settings;

// A hand edit with a trailing comma: the user's real settings, just not valid JSON.
const SYNTAX_ERROR = `{
  "appearance": { "theme": "light" },
  "autonomy": { "default": "supervised" },
}
`;

describe("SettingsStore with a broken settings.json", () => {
  it("keeps a copy of a file with a JSON syntax error before the next change overwrites it", () => {
    writeFileSync(file, SYNTAX_ERROR);
    const store = new SettingsStore(file);

    expect(store.get()).toEqual(Settings.parse({}));
    expect(backups()).toHaveLength(1);
    expect(backupText()).toBe(SYNTAX_ERROR);
    expect(store.reset).toMatchObject({ file, copy: join(dir, backups()[0] as string) });
    expect(store.reset?.reason).toMatch(/JSON/);

    store.update({ appearance: { theme: "system" } });
    expect(onDisk().appearance.theme).toBe("system");
    expect(backups()).toHaveLength(1);
    expect(backupText()).toBe(SYNTAX_ERROR);
  });

  it("keeps a copy of a file that parses but fails the schema", () => {
    const original = `${JSON.stringify({ appearance: { theme: "purple" } }, null, 2)}\n`;
    writeFileSync(file, original);
    const store = new SettingsStore(file);

    expect(store.get()).toEqual(Settings.parse({}));
    expect(backups()).toHaveLength(1);
    expect(backupText()).toBe(original);
    expect(store.reset?.reason).toMatch(/^appearance\.theme: /);
    expect(onDisk()).toEqual(Settings.parse({}));
  });

  it("starts a missing file from defaults with no copy and no reset", () => {
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(Settings.parse({}));
    expect(store.reset).toBeNull();
    expect(onDisk()).toEqual(Settings.parse({}));
    expect(backups()).toHaveLength(0);
  });

  it("loads a valid file as it is", () => {
    writeFileSync(file, JSON.stringify({ appearance: { theme: "light" } }));
    const store = new SettingsStore(file);
    expect(store.get().appearance.theme).toBe("light");
    expect(store.reset).toBeNull();
    expect(backups()).toHaveLength(0);
  });

  it("reads without writing for `codeden doctor`, leaving a broken file for the server", () => {
    writeFileSync(file, SYNTAX_ERROR);
    expect(SettingsStore.read(file)).toEqual(Settings.parse({}));
    expect(readFileSync(file, "utf8")).toBe(SYNTAX_ERROR);
    expect(backups()).toHaveLength(0);
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
    expect(SettingsStore.read(join(dir, "missing.json"))).toEqual(Settings.parse({}));
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });
});

describe("telling the user about a reset", () => {
  it("raises one inbox item that says where the old file is, and warns on stderr", () => {
    writeFileSync(file, SYNTAX_ERROR);
    const reset = new SettingsStore(file).reset;
    if (!reset) throw new Error("expected a reset");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const append = vi.fn();
    const log = vi.fn();

    const item = reportFileReset(reset, FILE_RESET_NOTICES.settings, {
      store: { append } as unknown as EventStore,
      log,
    });

    expect(append).toHaveBeenCalledWith([
      { type: "inbox.created", sessionId: null, payload: { item } },
    ]);
    expect(item).toMatchObject({ kind: "message", status: "open", notify: "failure" });
    expect(item.title).toBe("Settings were reset: settings.json could not be read");
    expect(item.body).toContain(reset.copy);
    expect(item.body).toContain(reset.reason);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reset.copy));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(reset.copy));
  });

  it("shows the reset in the inbox once when the server starts on a broken file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(file, SYNTAX_ERROR);
    const start = () =>
      startServer({
        port: 0,
        dataDir: dir,
        token: "s".repeat(64),
        runner: false,
        secrets: "memory",
        checkSetupOnStart: false,
      });
    const first = await start();
    const items = first.services.inbox.list().filter((i) => i.id.startsWith("inbox:file-reset:"));
    await first.close();
    expect(items).toHaveLength(1);
    expect(items[0]?.body).toContain(join(dir, backups()[0] as string));

    const second = await start();
    const again = second.services.inbox.list().filter((i) => i.id.startsWith("inbox:file-reset:"));
    await second.close();
    expect(again).toHaveLength(1);
    expect(backups()).toHaveLength(1);
  });

  it("gives each reset its own item id, from the copy", () => {
    const notice = FILE_RESET_NOTICES.settings;
    const a = fileResetInboxItem({ file, copy: `${file}.invalid-1`, reason: "x" }, notice);
    const b = fileResetInboxItem({ file, copy: `${file}.invalid-2`, reason: "x" }, notice);
    expect(a.id).toBe("inbox:file-reset:settings.json.invalid-1");
    expect(a.id).not.toBe(b.id);
  });
});
