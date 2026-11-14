import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageUsage, UsageSettings } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { inboxItems } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ImageUsageStore, localDate } from "../src/services/images/usage";
import { UsageService } from "../src/services/usage/usage-service";
import { type FileReset, loadUserJsonFile } from "../src/user-json-file";

/**
 * The other files in the data folder that hold the user's data and are written again later
 * (#170): a damaged one is kept as `<file>.invalid-<timestamp>` before anything overwrites it.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-user-files-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const copiesOf = (name: string) => readdirSync(dir).filter((n) => n.startsWith(`${name}.invalid-`));
const copyText = (name: string) => readFileSync(join(dir, copiesOf(name)[0] as string), "utf8");

describe("loadUserJsonFile", () => {
  it("never quotes the file's contents in the reason", () => {
    const file = join(dir, "remote-access.json");
    // An unquoted value: V8's own message for it quotes the text around it.
    const text = '{"hash": SECRET}';
    expect(() => JSON.parse(text)).toThrow(/SECRET/);
    writeFileSync(file, text);
    const { reset } = loadUserJsonFile(file, ImageUsage, {
      defaults: () => ({ date: "2026-11-13", total: 0, byProject: {} }),
    });
    expect(reset?.reason).toBe("not valid JSON");
  });

  it("gives the line and column of a JSON error", () => {
    const file = join(dir, "x.json");
    writeFileSync(file, '{\n  "a": 1,\n}\n');
    const { reset } = loadUserJsonFile(file, UsageSettings);
    expect(reset?.reason).toBe("not valid JSON at line 3, column 1");
  });
});

describe("image-usage.json", () => {
  const name = "image-usage.json";
  const today = localDate();

  it("keeps a damaged file before a reservation writes over it, and reports the reset", () => {
    const file = join(dir, name);
    const original = `{ "date": "${today}", "total": 50, "byProject": { "demo": 50 }, }\n`;
    writeFileSync(file, original);
    const resets: FileReset[] = [];
    const store = new ImageUsageStore(file, undefined, (r) => resets.push(r));

    expect(resets).toHaveLength(1);
    expect(resets[0]?.copy).toBe(join(dir, copiesOf(name)[0] as string));
    store.reserve(1, { global: 50 }, "demo");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ total: 1 });
    expect(copiesOf(name)).toHaveLength(1);
    expect(copyText(name)).toBe(original);
  });

  it("keeps a file with invalid counts too", () => {
    const file = join(dir, name);
    const original = JSON.stringify({ date: today, total: -3, byProject: {} });
    writeFileSync(file, original);
    const resets: FileReset[] = [];
    new ImageUsageStore(file, undefined, (r) => resets.push(r)).reserve(1, { global: 5 }, null);
    expect(resets[0]?.reason).toMatch(/^total: /);
    expect(copyText(name)).toBe(original);
  });

  it("starts a missing file at zero with no copy and no reset", () => {
    const onReset = vi.fn();
    const store = new ImageUsageStore(join(dir, name), undefined, onReset);
    expect(store.today()).toEqual({ date: today, total: 0, byProject: {} });
    expect(onReset).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("usage-settings.json", () => {
  const name = "usage-settings.json";
  const original = '{ "budgets": [], "timezone": "Europe/Amsterdam", }\n';
  let database: Database;
  let usage: UsageService;

  beforeEach(() => {
    database = openDatabase(join(dir, "codeden.db"));
    usage = new UsageService({
      db: database.db,
      store: new EventStore(database.db),
      settingsFile: join(dir, name),
    });
  });
  afterEach(() => database.close());

  const titles = () =>
    database.db
      .select()
      .from(inboxItems)
      .all()
      .map((i) => i.title);
  const RESET_TITLE = "Usage settings were reset: usage-settings.json could not be read";

  it("keeps a damaged file and tells the user when the settings are first read", () => {
    writeFileSync(join(dir, name), original);
    expect(usage.settings()).toEqual(UsageSettings.parse({}));
    expect(copyText(name)).toBe(original);
    expect(titles()).toEqual([RESET_TITLE]);
  });

  it("keeps a damaged file when the first thing that happens is a save", () => {
    writeFileSync(join(dir, name), original);
    usage.saveSettings({ timezone: "UTC" });
    expect(JSON.parse(readFileSync(join(dir, name), "utf8"))).toMatchObject({ timezone: "UTC" });
    expect(copiesOf(name)).toHaveLength(1);
    expect(copyText(name)).toBe(original);
    expect(titles()).toEqual([RESET_TITLE]);
  });

  it("saves over a missing file with no copy and no notice", () => {
    usage.saveSettings({ timezone: "UTC" });
    expect(copiesOf(name)).toHaveLength(0);
    expect(titles()).toEqual([]);
  });
});
