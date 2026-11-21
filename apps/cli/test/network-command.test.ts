import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccessFile } from "@codeden/contracts";
import {
  ensureHome,
  ensureInstallToken,
  RemoteAccessStore,
  type RunningServer,
  startServer,
} from "@codeden/server";
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
    expect(out.join("\n")).toMatch(/is on/);
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

describe("codeden network origin / --loopback-only (server stopped)", () => {
  const stored = () => RemoteAccessFile.parse(JSON.parse(readFileSync(file(), "utf8")));

  it("adds, lists and removes trusted origins, normalizing them", async () => {
    expect(await networkCommand(home, "origin", { args: ["add", "https://Box.TS.net:443"] })).toBe(
      0,
    );
    expect(stored().trustedOrigins).toEqual(["https://box.ts.net"]);
    expect(await networkCommand(home, "origin", { args: ["add", "https://box.ts.net:8445"] })).toBe(
      0,
    );
    out.length = 0;
    expect(await networkCommand(home, "origin", { args: ["list"] })).toBe(0);
    expect(out.join("\n")).toContain("https://box.ts.net:8445");
    expect(await networkCommand(home, undefined)).toBe(0);
    expect(out.join("\n")).toContain("https://box.ts.net\n");
    expect(await networkCommand(home, "origin", { args: ["remove", "https://BOX.ts.net"] })).toBe(
      0,
    );
    expect(stored().trustedOrigins).toEqual(["https://box.ts.net:8445"]);
    expect(await networkCommand(home, "origin", { args: ["remove", "https://nope.ts.net"] })).toBe(
      1,
    );
  });

  it("refuses bad origins and bad usage", async () => {
    for (const url of ["http://box.ts.net", "https://box.ts.net/x", "https://127.0.0.1"]) {
      expect(await networkCommand(home, "origin", { args: ["add", url] }), url).toBe(1);
    }
    expect(new RemoteAccessStore(file()).trustedOrigins).toEqual([]);
    expect(await networkCommand(home, "origin", { args: ["add"] })).toBe(2);
    expect(await networkCommand(home, "origin", { args: ["frob", "x"] })).toBe(2);
    expect(await networkCommand(home, "off", { loopbackOnly: true })).toBe(2);
  });

  it("keeps at most ten", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await networkCommand(home, "origin", { args: ["add", `https://h${i}.ts.net`] })).toBe(
        0,
      );
    }
    expect(await networkCommand(home, "origin", { args: ["add", "https://h10.ts.net"] })).toBe(1);
    expect(stored().trustedOrigins).toHaveLength(10);
  });

  it("turns on loopback only, and a plain `on` goes wide again", async () => {
    await passwordCommand(home, { generate: true });
    expect(await networkCommand(home, "on", { loopbackOnly: true })).toBe(0);
    expect(stored()).toMatchObject({ enabled: true, loopbackOnly: true });
    expect(out.join("\n")).toMatch(/loopback only/);
    expect(await networkCommand(home, undefined)).toBe(0);
    expect(out.join("\n")).toMatch(/is on, loopback only \(CodeDen is not running\)/);
    expect(await networkCommand(home, "on")).toBe(0);
    expect(stored().loopbackOnly).toBe(false);
  });

  it("drops hand-edited origins that break the rules instead of trusting them", () => {
    writeFileSync(
      file(),
      JSON.stringify({
        trustedOrigins: ["http://a.ts.net", "https://ok.ts.net", "https://127.0.0.1"],
      }),
    );
    expect(new RemoteAccessStore(file()).trustedOrigins).toEqual(["https://ok.ts.net"]);
  });
});

describe("codeden network origin / --loopback-only (server running)", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("goes through the running server, which applies it live", async () => {
    server = await startServer({
      port: 0,
      dataDir: home,
      token: ensureInstallToken(ensureHome(home).token),
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
    });
    expect(await passwordCommand(home, { generate: true })).toBe(0);
    expect(await networkCommand(home, "origin", { args: ["add", "https://Box.ts.net:8445"] })).toBe(
      0,
    );
    expect(server.network.store.trustedOrigins).toEqual(["https://box.ts.net:8445"]);
    expect(await networkCommand(home, "origin", { args: ["add", "http://box.ts.net"] })).toBe(1);
    out.length = 0;
    expect(await networkCommand(home, "origin", { args: ["list"] })).toBe(0);
    expect(out.join("\n")).toContain("https://box.ts.net:8445");

    expect(await networkCommand(home, "on", { loopbackOnly: true })).toBe(0);
    expect(server.network.enabled).toBe(true);
    expect(server.network.desiredHost()).toBe("127.0.0.1");
    expect(out.join("\n")).toMatch(/loopback only/);
    expect(await networkCommand(home, "on")).toBe(0);
    expect(server.network.desiredHost()).toBe("0.0.0.0");
    await networkCommand(home, "off");

    expect(
      await networkCommand(home, "origin", { args: ["remove", "https://box.ts.net:8445"] }),
    ).toBe(0);
    expect(server.network.store.trustedOrigins).toEqual([]);
    expect(
      await networkCommand(home, "origin", { args: ["remove", "https://box.ts.net:8445"] }),
    ).toBe(1);
  });
});
