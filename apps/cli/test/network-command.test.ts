import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccessFile } from "@codeden/contracts";
import { RemoteAccessStore } from "@codeden/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkCommand, passwordCommand } from "../src/network-command";

/** `codeden password` and `codeden network` with no server running: they edit the home. */
let home: string;
let out: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-cli-net-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, "remote-access.json");

describe("codeden network / password (server stopped)", () => {
  it("refuses to turn network access on before a password is set", async () => {
    expect(await networkCommand(home, "on")).toBe(1);
    expect(out.join("\n")).toMatch(/codeden password/);
    expect(await networkCommand(home, "sideways")).toBe(2);
  });

  it("generates a password once, stores only its hash, then switches on and off", async () => {
    expect(await passwordCommand(home, { generate: true })).toBe(0);
    const phrase = out.find((l) => /^ {2}[a-z]+(-[a-z]+){4}$/.test(l))?.trim() as string;
    expect(phrase).toBeDefined();
    const raw = readFileSync(file(), "utf8");
    expect(raw).not.toContain(phrase);
    expect(await new RemoteAccessStore(file()).checkPassword(phrase)).toBe(true);

    expect(await networkCommand(home, "on")).toBe(0);
    expect(RemoteAccessFile.parse(JSON.parse(readFileSync(file(), "utf8"))).enabled).toBe(true);
    expect(out.join("\n")).toMatch(/localhost:4317/);
    expect(await networkCommand(home, undefined)).toBe(0);
    expect(out.at(-1)).toMatch(/is on/);
    expect(await networkCommand(home, "off")).toBe(0);
    expect(RemoteAccessFile.parse(JSON.parse(readFileSync(file(), "utf8"))).enabled).toBe(false);
  });

  it("keeps a damaged file before saving over it, and says so on stderr (#170)", async () => {
    const text = '{ "enabled": true, "password": { "hash": "scrypt$SECRET" }, }';
    writeFileSync(file(), text);
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => void errors.push(a.join(" ")));

    expect(await networkCommand(home, "off")).toBe(0);
    const copies = readdirSync(home).filter((n) => n.startsWith("remote-access.json.invalid-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(home, copies[0] as string), "utf8")).toBe(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Network access settings were reset");
    expect(errors[0]).toContain(join(home, copies[0] as string));
    expect(errors[0]).not.toContain("SECRET");
  });
});
