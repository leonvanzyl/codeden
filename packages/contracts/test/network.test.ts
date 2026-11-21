import { describe, expect, it } from "vitest";
import {
  AddTrustedOriginRequest,
  AuthStatus,
  NetworkStatus,
  PASSWORD_MIN_LENGTH,
  parseTrustedOrigin,
  passwordProblem,
  RemoteAccessFile,
  SetNetworkAccessRequest,
  SetNetworkPasswordRequest,
  SetNetworkPasswordResponse,
  SignInError,
  SignInRequest,
} from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

const status: NetworkStatus = {
  enabled: true,
  passwordSet: true,
  passwordSetAt: "2026-11-08T09:00:00.000Z",
  listening: "network",
  loopbackOnly: false,
  trustedOrigins: ["https://box.tail1234.ts.net:8445"],
  port: 4317,
  addresses: [
    {
      kind: "local",
      label: "This computer",
      interfaceName: null,
      host: "localhost",
      url: "http://localhost:4317",
    },
    {
      kind: "lan",
      label: "Wi-Fi",
      interfaceName: "Wi-Fi",
      host: "192.168.1.20",
      url: "http://192.168.1.20:4317",
    },
    {
      kind: "vpn",
      label: "Tailscale",
      interfaceName: "Tailscale",
      host: "100.101.102.103",
      url: "http://100.101.102.103:4317",
    },
  ],
  candidates: [],
  devices: [
    {
      id: "d1",
      label: "Mozilla/5.0 (iPhone)",
      addressViaProxy: false,
      address: "192.168.1.30",
      createdAt: "2026-11-08T09:00:00.000Z",
      lastSeenAt: "2026-11-08T09:10:00.000Z",
      expiresAt: "2027-02-06T09:00:00.000Z",
      current: false,
    },
  ],
  remote: false,
};

describe("network access contracts", () => {
  it("round-trips the status and request shapes", () => {
    roundTrip(NetworkStatus, status);
    roundTrip(SetNetworkPasswordResponse, { status, generated: "maple-river-quiet-orbit-candle" });
    roundTrip(SetNetworkPasswordResponse, { status, generated: null });
    roundTrip(SetNetworkPasswordRequest, { password: "a long enough password" });
    roundTrip(SetNetworkPasswordRequest, { generate: true });
    roundTrip(SetNetworkAccessRequest, { enabled: false });
    roundTrip(SignInRequest, { password: "x" });
    roundTrip(AuthStatus, { remote: true, signedIn: false, networkEnabled: true });
    roundTrip(SignInError, {
      error: { code: "rate_limited", message: "Wait 2 s", retryAfterSec: 2 },
    });
  });

  it("rejects bad requests", () => {
    expect(SetNetworkPasswordRequest.safeParse({}).success).toBe(false);
    expect(SetNetworkPasswordRequest.safeParse({ generate: false }).success).toBe(false);
    expect(SetNetworkAccessRequest.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(NetworkStatus.safeParse({ ...status, listening: "everywhere" }).success).toBe(false);
  });

  it("defaults the persisted file to off with no password and keeps only token hashes", () => {
    expect(RemoteAccessFile.parse({})).toEqual({
      schemaVersion: 1,
      enabled: false,
      password: null,
      sessions: [],
      loopbackOnly: false,
      trustedOrigins: [],
    });
    const file: RemoteAccessFile = {
      schemaVersion: 1,
      enabled: true,
      password: { hash: "scrypt$32768$8$1$c2FsdA$aGFzaA", setAt: "2026-11-08T09:00:00.000Z" },
      loopbackOnly: true,
      trustedOrigins: ["https://box.tail1234.ts.net:8445"],
      sessions: [
        {
          id: "s1",
          tokenHash: "a".repeat(64),
          label: "Safari",
          address: "192.168.1.30",
          addressViaProxy: true,
          createdAt: "2026-11-08T09:00:00.000Z",
          lastSeenAt: "2026-11-08T09:00:00.000Z",
          expiresAt: "2027-02-06T09:00:00.000Z",
        },
      ],
    };
    roundTrip(RemoteAccessFile, file);
    expect(() =>
      RemoteAccessFile.parse({ ...file, password: { hash: "plain", setAt: file.password?.setAt } }),
    ).toThrow();
    expect(() =>
      RemoteAccessFile.parse({ ...file, sessions: [{ ...file.sessions[0], tokenHash: "raw" }] }),
    ).toThrow();
  });
});

describe("passwordProblem", () => {
  it("requires at least 15 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(15);
    expect(passwordProblem("short pass")).toMatch(/at least 15/);
    expect(passwordProblem("fourteen chars")).toMatch(/at least 15/);
    expect(passwordProblem("a".repeat(300))).toMatch(/at most/);
  });

  it("accepts passphrases and long sentences", () => {
    expect(passwordProblem("maple-river-quiet-orbit-candle")).toBeNull();
    expect(passwordProblem("my cat sleeps on the router")).toBeNull();
    expect(passwordProblem("Tr0ub4dor&3-and-more")).toBeNull();
    expect(passwordProblem("839201746518203")).toBeNull();
  });

  it("refuses repeats", () => {
    for (const pw of [
      "aaaaaaaaaaaaaaa",
      "abababababababab",
      "abcabcabcabcabcabc",
      "1111122222111112",
    ]) {
      expect(passwordProblem(pw), pw).toMatch(/repeats/);
    }
  });

  it("refuses sequences, forwards and backwards", () => {
    for (const pw of [
      "abcdefghijklmnop",
      "123456789012345",
      "zyxwvutsrqponmlk",
      "qwertyuiopasdfgh",
      "1qaz2wsx3edc4rfv",
      "9876543210987654",
    ]) {
      expect(passwordProblem(pw), pw).toMatch(/sequence/);
    }
  });

  it("refuses very common passwords padded out", () => {
    for (const pw of [
      "passwordpassword",
      "password1234567",
      "Password!2026!!!",
      "iloveyou iloveyou",
      "correcthorsebatterystaple",
      "correct horse battery staple",
      "letmein-letmein!",
    ]) {
      expect(passwordProblem(pw), pw).not.toBeNull();
    }
  });
});

describe("trusted origins", () => {
  const origin = (input: string) => {
    const r = parseTrustedOrigin(input);
    return r.ok ? r.origin : null;
  };

  it("normalizes: lowercase, :443 dropped", () => {
    expect(origin("https://Box.Tail1234.TS.net:8445")).toBe("https://box.tail1234.ts.net:8445");
    expect(origin("https://box.ts.net:443")).toBe("https://box.ts.net");
    expect(origin("  https://box.ts.net ")).toBe("https://box.ts.net");
    expect(origin("https://my-box")).toBe("https://my-box");
  });

  it("refuses http, paths, queries, fragments, credentials, IPs and loopback names", () => {
    for (const bad of [
      "http://box.ts.net",
      "box.ts.net",
      "https://box.ts.net/",
      "https://box.ts.net/app",
      "https://box.ts.net?x=1",
      "https://box.ts.net/?x=1",
      "https://box.ts.net#x",
      "https://user@box.ts.net",
      "https://user:pw@box.ts.net",
      "https://127.0.0.1:8445",
      "https://100.101.102.103",
      "https://[::1]:8445",
      "https://localhost",
      "https://x.localhost",
      "https://box.ts.net:0",
      "https://box.ts.net:65536",
      "https://box.ts.net:80:90",
      "https://-box.ts.net",
      "https://box..ts.net",
      "https://bo x.ts.net",
      "https://",
    ]) {
      expect(origin(bad), bad).toBeNull();
    }
  });

  it("is used by the add request", () => {
    expect(AddTrustedOriginRequest.parse({ url: "https://A.ts.net:443" }).url).toBe(
      "https://a.ts.net",
    );
    expect(AddTrustedOriginRequest.safeParse({ url: "http://a.ts.net" }).success).toBe(false);
  });

  it("lets a network change name loopbackOnly, enabled or both, but not nothing", () => {
    expect(SetNetworkAccessRequest.safeParse({ loopbackOnly: true }).success).toBe(true);
    expect(SetNetworkAccessRequest.safeParse({ enabled: true, loopbackOnly: true }).success).toBe(
      true,
    );
    expect(SetNetworkAccessRequest.safeParse({}).success).toBe(false);
  });

  it("is enforced by the shared schemas, not only the store", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://h${i}.ts.net`);
    expect(NetworkStatus.safeParse({ ...status, trustedOrigins: eleven }).success).toBe(false);
    for (const bad of ["http://a.ts.net/x", "https://a.ts.net/", "https://Upper.ts.net"]) {
      // Only the normalized form is accepted from the wire.
      const parsed = NetworkStatus.safeParse({ ...status, trustedOrigins: [bad] });
      expect(parsed.success && parsed.data.trustedOrigins[0] === bad, bad).toBe(false);
    }
    expect(NetworkStatus.parse({ ...status, trustedOrigins: undefined }).trustedOrigins).toEqual(
      [],
    );
  });

  it("drops bad hand-edited entries from the file, keeping the rest and the password", () => {
    const edited = {
      password: { hash: "scrypt$32768$8$1$c2FsdA$aGFzaA", setAt: "2026-11-08T09:00:00.000Z" },
      trustedOrigins: [
        "http://a.ts.net/x",
        "HTTPS://Ok.ts.net:443",
        "https://ok.ts.net",
        42,
        ...Array.from({ length: 12 }, (_, i) => `https://h${i}.ts.net`),
      ],
    };
    const file = RemoteAccessFile.parse(edited);
    expect(file.password).not.toBeNull();
    expect(file.trustedOrigins).toHaveLength(10);
    expect(file.trustedOrigins.slice(0, 2)).toEqual(["https://ok.ts.net", "https://h0.ts.net"]);
    expect(RemoteAccessFile.parse({ trustedOrigins: "nope" }).trustedOrigins).toEqual([]);
  });
});
