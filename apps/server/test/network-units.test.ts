import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passwordProblem, RemoteAccessFile } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  isVpnRange,
  listAddresses,
  normalizeAddress,
} from "../src/network/addresses";
import { generatePassphrase, hashPassword, verifyPassword } from "../src/network/password";
import { SignInLimiter } from "../src/network/rate-limit";
import { PasswordRuleError, RemoteAccessStore } from "../src/network/store";
import { PASSPHRASE_WORDS } from "../src/network/words";
import type { FileReset } from "../src/user-json-file";

const FAST = { N: 1024, r: 8, p: 1 };
const GOOD = "maple-river-quiet-orbit-candle";

describe("password hashing", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword(GOOD, FAST);
    const b = await hashPassword(GOOD, FAST);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(`${GOOD}!`, a)).toBe(false);
    expect(await verifyPassword(GOOD, "scrypt$bad")).toBe(false);
    expect(await verifyPassword(GOOD, "plain")).toBe(false);
  });

  it("uses a strong default cost", async () => {
    expect(await hashPassword(GOOD)).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it("generates five-word passphrases that pass the rules", () => {
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length);
    expect(PASSPHRASE_WORDS.length).toBeGreaterThanOrEqual(800);
    for (const word of PASSPHRASE_WORDS) expect(word).toMatch(/^[a-z]{3,9}$/);
    for (let i = 0; i < 50; i++) {
      const phrase = generatePassphrase();
      expect(phrase.split("-")).toHaveLength(5);
      expect(passwordProblem(phrase)).toBeNull();
    }
    // A deterministic picker shows the words come from the list.
    expect(generatePassphrase((max) => max - 1)).toBe(
      Array(5).fill(PASSPHRASE_WORDS.at(-1)).join("-"),
    );
  });
});

describe("SignInLimiter", () => {
  it("lets three failures through, then waits 1 s, 2 s, 4 s … up to 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(SignInLimiter.delayAfter)).toEqual([
      0, 0, 0, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    let now = 1_000_000;
    const limiter = new SignInLimiter(() => now);
    const ip = "192.168.1.30";
    for (let i = 0; i < 3; i++) {
      expect(limiter.check(ip).allowed).toBe(true);
      limiter.fail(ip);
    }
    expect(limiter.check(ip)).toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterMs: 1000,
    });
    now += 999;
    expect(limiter.check(ip).allowed).toBe(false);
    now += 1;
    expect(limiter.check(ip).allowed).toBe(true);
    limiter.fail(ip);
    expect(limiter.check(ip)).toMatchObject({ allowed: false, retryAfterMs: 2000 });
    // Other addresses are unaffected.
    expect(limiter.check("192.168.1.31").allowed).toBe(true);
  });

  it("locks an address out for 15 minutes after 10 failures in 15 minutes", () => {
    let now = 0;
    const limiter = new SignInLimiter(() => now);
    const ip = "10.0.0.5";
    for (let i = 0; i < 10; i++) {
      now += 31_000;
      expect(limiter.check(ip).allowed).toBe(true);
      limiter.fail(ip);
    }
    expect(limiter.check(ip)).toEqual({
      allowed: false,
      reason: "locked_out",
      retryAfterMs: 15 * 60_000,
    });
    expect(limiter.check("10.0.0.6").allowed).toBe(true);
    now += 15 * 60_000 - 1;
    expect(limiter.check(ip).allowed).toBe(false);
    now += 1;
    expect(limiter.check(ip).allowed).toBe(true);
  });

  it("forgets failures older than 15 minutes, and on success", () => {
    let now = 0;
    const limiter = new SignInLimiter(() => now);
    for (let i = 0; i < 3; i++) limiter.fail("a");
    now += 15 * 60_000;
    expect(limiter.check("a").allowed).toBe(true);
    limiter.fail("a");
    expect(limiter.check("a").allowed).toBe(true);
    for (let i = 0; i < 3; i++) limiter.fail("b");
    limiter.succeed("b");
    expect(limiter.check("b").allowed).toBe(true);
  });
});

describe("loopback classification", () => {
  it("treats 127/8, ::1 and their IPv4-mapped forms as this machine", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });

  it("treats everything else, and unknown peers, as remote", () => {
    for (const a of [
      "192.168.1.20",
      "::ffff:192.168.1.20",
      "10.0.0.1",
      "100.100.1.1",
      "fe80::1",
      "128.0.0.1",
      "",
      undefined,
      null,
      "localhost",
      "127.0.0.1.evil",
    ]) {
      expect(isLoopbackAddress(a), String(a)).toBe(false);
    }
    expect(normalizeAddress("::ffff:10.1.2.3")).toBe("10.1.2.3");
  });
});

const iface = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

describe("listAddresses", () => {
  it("lists localhost, LAN addresses, then VPN and Tailscale addresses", () => {
    const list = listAddresses(4317, {
      Loopback: [iface("127.0.0.1", true)],
      Tailscale: [iface("100.101.102.103")],
      "Wi-Fi": [
        iface("192.168.1.20"),
        { ...iface("fe80::1"), family: "IPv6", cidr: "fe80::1/64", scopeid: 1 },
      ],
      Ethernet: [iface("10.0.0.7"), iface("169.254.3.4")],
      wg0: [iface("10.8.0.2")],
      "vEthernet (WSL (Hyper-V firewall))": [iface("172.20.0.1")],
      docker0: [iface("172.17.0.1")],
      "VirtualBox Host-Only Network": [iface("192.168.56.1")],
      utun3: [iface("100.64.0.9")],
    });
    expect(list.map((a) => [a.kind, a.label, a.url])).toEqual([
      ["local", "This computer", "http://localhost:4317"],
      ["lan", "Wi-Fi", "http://192.168.1.20:4317"],
      ["lan", "Ethernet", "http://10.0.0.7:4317"],
      ["vpn", "Tailscale", "http://100.101.102.103:4317"],
      ["vpn", "VPN (wg0)", "http://10.8.0.2:4317"],
      ["vpn", "Tailscale", "http://100.64.0.9:4317"],
    ]);
    expect(isVpnRange("100.64.0.0")).toBe(true);
    expect(isVpnRange("100.127.255.255")).toBe(true);
    expect(isVpnRange("100.128.0.1")).toBe(false);
    expect(isVpnRange("100.63.0.1")).toBe(false);
  });

  it("is just localhost with no network", () => {
    expect(listAddresses(9, {})).toHaveLength(1);
  });
});

describe("RemoteAccessStore", () => {
  let dir: string;
  let file: string;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-remote-"));
    file = join(dir, "remote-access.json");
    now = Date.parse("2026-11-08T10:00:00.000Z");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = () => new RemoteAccessStore(file, () => now);

  it("starts off with no password and refuses to switch on without one", () => {
    const store = make();
    expect(store.enabled).toBe(false);
    expect(store.passwordSet).toBe(false);
    expect(() => store.setEnabled(true)).toThrow(/password/);
  });

  it("refuses weak passwords and stores only a hash", async () => {
    const store = make();
    await expect(store.setPassword("too short")).rejects.toBeInstanceOf(PasswordRuleError);
    await store.setPassword(GOOD);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(GOOD);
    const saved = RemoteAccessFile.parse(JSON.parse(raw));
    expect(saved.password?.hash).toMatch(/^scrypt\$/);
    expect(await store.checkPassword(GOOD)).toBe(true);
    expect(await store.checkPassword("maple-river-quiet-orbit-candles")).toBe(false);
    store.setEnabled(true);
    expect(make().enabled).toBe(true);
  });

  it("runs the session lifecycle: create, verify, expire, revoke, revoke all", async () => {
    const store = make();
    await store.setPassword(GOOD);
    const a = store.createSession({ label: "iPhone Safari", address: "192.168.1.30" });
    const b = store.createSession({ label: "x".repeat(500), address: null });
    expect(a.token).toMatch(/^cds_/);
    expect(readFileSync(file, "utf8")).not.toContain(a.token);
    expect(b.session.label).toHaveLength(200);
    expect(store.verifySession(a.token)?.id).toBe(a.session.id);
    expect(store.verifySession("cds_nope")).toBeUndefined();
    expect(store.verifySession(undefined)).toBeUndefined();
    expect(Date.parse(a.session.expiresAt) - now).toBe(90 * 24 * 60 * 60_000);

    // Seen times move with use.
    now += 5 * 60_000;
    expect(store.verifySession(a.token)?.lastSeenAt).toBe(new Date(now).toISOString());
    // A fresh store (a restart) still knows the session.
    expect(make().verifySession(a.token)?.id).toBe(a.session.id);

    expect(store.revoke(a.session.id)).toBe(true);
    expect(store.revoke(a.session.id)).toBe(false);
    expect(store.verifySession(a.token)).toBeUndefined();
    expect(store.verifySession(b.token)).toBeDefined();
    store.revokeAll();
    expect(store.verifySession(b.token)).toBeUndefined();

    const c = store.createSession({ label: "Pixel", address: "10.0.0.2" });
    now += 90 * 24 * 60 * 60_000;
    expect(store.verifySession(c.token)).toBeUndefined();
    expect(store.liveSessions()).toEqual([]);
  });

  it("signs every device out when the password changes", async () => {
    const store = make();
    await store.setPassword(GOOD);
    const a = store.createSession({ label: "Phone", address: "192.168.1.30" });
    await store.setPassword("a whole new sentence for the den");
    expect(store.verifySession(a.token)).toBeUndefined();
    expect(store.liveSessions()).toHaveLength(0);
  });

  it("fails closed on a damaged file", () => {
    writeFileSync(file, '{"enabled": true, "password": "oops"}');
    const store = make();
    expect(store.enabled).toBe(false);
    expect(store.passwordSet).toBe(false);
  });

  // #170: a damaged file is kept (owner-only) before a save can write over it.
  const HASH = "scrypt$1024$8$1$c2FsdA==$SECRET-HASH";
  const copies = () => readdirSync(dir).filter((n) => n.startsWith("remote-access.json.invalid-"));
  const resetsOf = () => {
    const resets: FileReset[] = [];
    const store = new RemoteAccessStore(
      file,
      () => now,
      (r) => resets.push(r),
    );
    return { store, resets };
  };

  it.each([
    ["not valid JSON", `{ "enabled": true, "password": { "hash": "${HASH}" }, }`],
    ["invalid values", JSON.stringify({ enabled: true, password: { hash: 42, setAt: "x" } })],
  ])("keeps a file with %s before the next save, and reports it without the hash", (_, text) => {
    writeFileSync(file, text);
    const { store, resets } = resetsOf();
    expect(store.enabled).toBe(false);
    expect(store.passwordSet).toBe(false);
    store.setEnabled(false);

    expect(copies()).toHaveLength(1);
    expect(readFileSync(join(dir, copies()[0] as string), "utf8")).toBe(text);
    expect(resets).toHaveLength(1);
    expect(resets[0]?.copy).toBe(join(dir, copies()[0] as string));
    expect(resets[0]?.reason).not.toMatch(/SECRET|42/);
    expect(RemoteAccessFile.parse(JSON.parse(readFileSync(file, "utf8"))).enabled).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the copy owner-only, like the file", () => {
    writeFileSync(file, "{ nope", { mode: 0o644 });
    resetsOf();
    expect(statSync(join(dir, copies()[0] as string)).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts a missing file closed, with no copy and no reset", () => {
    const { store, resets } = resetsOf();
    expect(store.enabled).toBe(false);
    store.setEnabled(false);
    expect(resets).toEqual([]);
    expect(copies()).toEqual([]);
  });
});
