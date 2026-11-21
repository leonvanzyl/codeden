import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkStatus, SetNetworkPasswordResponse, SignInError } from "@codeden/contracts";
import { uiContentSecurityPolicy } from "@codeden/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkAccess } from "../src/network/access";
import type { BindHost, HttpListener } from "../src/network/listener";
import { RemoteAccessStore } from "../src/network/store";
import { authRoutes, networkRoutes } from "../src/routes/network";
import { errorResponse } from "../src/routes/validate";
import { loopbackOrigins, securityMiddleware } from "../src/security";
import { removeTree } from "./support/remove-tree";

/**
 * The security middleware and the sign-in routes with the peer address injected the way
 * `@hono/node-server` provides it (`env.incoming.socket.remoteAddress`), so remote requests
 * can be simulated without a second machine.
 */
const TOKEN = "t".repeat(64);
const PORT = 4400;
const LAN = "192.168.1.20";
const TAILSCALE = "100.101.102.103";
const PHONE = "192.168.1.30";
const GOOD = "maple-river-quiet-orbit-candle";

class FakeListener {
  host: BindHost = "127.0.0.1";
  port = PORT;
  dropped = 0;
  async rebind(host: BindHost) {
    this.host = host;
  }
  dropRemote() {
    this.dropped++;
    return 0;
  }
}

let dir: string;
let listener: FakeListener;
let network: NetworkAccess;
let app: Hono;

function build() {
  listener = new FakeListener();
  network = new NetworkAccess({
    store: new RemoteAccessStore(join(dir, "remote-access.json")),
    listener: listener as unknown as HttpListener,
    interfaces: () => ({
      "Wi-Fi": [
        {
          address: LAN,
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: `${LAN}/24`,
        },
      ],
      Tailscale: [
        {
          address: TAILSCALE,
          family: "IPv4",
          internal: false,
          netmask: "255.192.0.0",
          mac: "00:00:00:00:00:00",
          cidr: `${TAILSCALE}/10`,
        },
      ],
    }),
    securityLogFile: join(dir, "remote-access.log"),
  });
  const ctx = {
    network,
    sessionCookie: () => `codeden_session_${PORT}`,
    tokenCookie: () => `codeden_token_${PORT}`,
    token: TOKEN,
  };
  const base = new Set(loopbackOrigins(PORT));
  app = new Hono();
  app.use(
    "*",
    securityMiddleware({
      token: TOKEN,
      cookieName: ctx.tokenCookie,
      allowedOrigins: () =>
        new Set([...base, ...[...network.ownHosts()].map((h) => `http://${h}:${PORT}`)]),
      publicPaths: new Set(["/api/health", "/mcp"]),
      loopbackOnlyPaths: new Set(["/mcp", "/api/browser/relay"]),
      remote: {
        enabled: () => network.enabled,
        ownHosts: () => network.ownHosts(),
        trustedOrigins: () => network.store.trustedOrigins,
        port: () => PORT,
        sessionCookieName: ctx.sessionCookie,
        verifySession: (t) => network.store.verifySession(t),
      },
    }),
  );
  const api = new Hono()
    .onError((e, c) => errorResponse(e, c))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/snapshot", (c) => c.json({ snapshot: true }))
    .route("/network", networkRoutes(ctx))
    .route("/auth", authRoutes(ctx));
  app.route("/api", api);
  app.all("/mcp", (c) => c.json({ mcp: true }));
  app.get("/ws", (c) => c.text("socket"));
  app.get("/api/browser/relay", (c) => c.text("relay"));
  app.get("/csp", (c) =>
    c.text(c.req.header("host") ?? "", 200, {
      "content-security-policy": uiContentSecurityPolicy(c.req.header("host")),
    }),
  );
  app.get("*", (c) => c.html("<!doctype html><div id=root></div>"));
}

/** A request from `peer`, with `Host` defaulting to the address it dialled. */
function from(
  peer: string,
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", init.host ?? `127.0.0.1:${PORT}`);
  return Promise.resolve(
    app.request(
      `http://${headers.get("host")}${path}`,
      { ...init, headers },
      { incoming: { socket: { remoteAddress: peer } } },
    ),
  );
}
const local = (path: string, init: RequestInit & { host?: string } = {}) =>
  from("127.0.0.1", path, init);
const phone = (path: string, init: RequestInit & { host?: string } = {}) =>
  from(PHONE, path, { host: `${LAN}:${PORT}`, ...init });
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});
const auth = { authorization: `Bearer ${TOKEN}` };
const statusOf = async (res: Response) => (await res.json()) as NetworkStatus;
const errorOf = async (res: Response) => (await res.json()) as SignInError;

async function enable() {
  await network.setPassword({ password: GOOD });
  await network.setEnabled(true);
}

async function signIn(password = GOOD, peer = PHONE): Promise<Response> {
  return from(peer, "/api/auth/sign-in", {
    host: `${LAN}:${PORT}`,
    ...json({ password }, { "user-agent": "Mozilla/5.0 (iPhone)" }),
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] as string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-netsec-"));
  build();
});
afterEach(() => removeTree(dir));

describe("with network access off", () => {
  it("refuses every remote peer, even with the install token", async () => {
    expect((await phone("/api/snapshot", { headers: auth })).status).toBe(403);
    expect((await phone("/")).status).toBe(403);
    expect((await local("/api/snapshot", { headers: auth })).status).toBe(200);
  });

  it("refuses to switch on without a password", async () => {
    const res = await local("/api/network", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "password_required",
    );
    expect(listener.host).toBe("127.0.0.1");
    expect(network.desiredHost()).toBe("127.0.0.1");
  });
});

describe("Host and Origin checks", () => {
  beforeEach(enable);

  it("accepts the machine's own LAN and VPN addresses on the server port", async () => {
    const res = await signIn();
    const cookie = cookieOf(res);
    for (const host of [`${LAN}:${PORT}`, `${TAILSCALE}:${PORT}`]) {
      const ok = await phone("/api/snapshot", {
        host,
        headers: { cookie, host, origin: `http://${host}` },
      });
      expect(ok.status, host).toBe(200);
    }
  });

  it("refuses other hosts, other ports, foreign, null and same-site different-port origins", async () => {
    const cookie = cookieOf(await signIn());
    const cases: [Record<string, string>, string][] = [
      [{ host: `evil.example:${PORT}` }, "Forbidden host"],
      [{ host: `${LAN}:5173` }, "Forbidden host"],
      [{ host: `192.168.1.99:${PORT}` }, "Forbidden host"],
      [{ origin: "http://evil.example" }, "Forbidden origin"],
      [{ origin: "null" }, "Forbidden origin"],
      [{ origin: `http://${LAN}:5173` }, "Forbidden origin"],
      [{ origin: `https://${LAN}:${PORT}` }, "Forbidden origin"],
    ];
    for (const [headers, message] of cases) {
      const res = await phone("/api/snapshot", { headers: { cookie, ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.text()).toBe(message);
    }
    // Loopback keeps refusing LAN hosts' foreign origins too.
    expect((await local("/api/snapshot", { headers: { ...auth, origin: "null" } })).status).toBe(
      403,
    );
  });

  it("stops accepting LAN hosts once network access is off", async () => {
    await network.setEnabled(false);
    expect(network.ownHosts().size).toBe(0);
    const res = await local("/api/snapshot", { headers: { ...auth, host: `${LAN}:${PORT}` } });
    expect(res.status).toBe(403);
  });
});

describe("remote requests", () => {
  beforeEach(enable);

  it("need a session: the install token and spoofed forwarding headers grant nothing", async () => {
    const attempts: Record<string, string>[] = [
      {},
      auth,
      { cookie: `codeden_token_${PORT}=${TOKEN}` },
      { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", forwarded: "for=127.0.0.1" },
      { "x-forwarded-host": `127.0.0.1:${PORT}`, "x-forwarded-proto": "https", ...auth },
    ];
    for (const headers of attempts) {
      const res = await phone("/api/snapshot", { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "sign_in_required" } });
    }
    expect((await phone(`/api/snapshot?token=${TOKEN}`)).status).toBe(401);
    expect((await phone("/ws", { headers: auth })).status).toBe(401);
  });

  it("get the UI shell and sign-in endpoints while signed out", async () => {
    const shell = await phone("/sessions/abc");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("root");
    expect((await phone("/api/health")).status).toBe(200);
    expect(await (await phone("/api/auth/status")).json()).toEqual({
      remote: true,
      signedIn: false,
      networkEnabled: true,
    });
  });

  it("never reach /mcp, with or without a session or an agent token", async () => {
    const cookie = cookieOf(await signIn());
    for (const method of ["GET", "POST"]) {
      for (const headers of [{}, { cookie }, { authorization: "Bearer cdm_anything" }]) {
        const res = await phone("/mcp", { method, headers });
        expect(res.status).toBe(404);
      }
    }
    // Agents on this machine still reach it.
    expect((await local("/mcp")).status).toBe(200);
  });

  it("can't change network access or the password", async () => {
    const cookie = cookieOf(await signIn());
    const off = await phone("/api/network", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(403);
    const pw = await phone("/api/network/password", {
      ...json({ generate: true }),
      headers: { cookie, "content-type": "application/json" },
    });
    expect(pw.status).toBe(403);
    expect(network.enabled).toBe(true);
    // Reading the status is fine, and says the caller is remote.
    const status = await phone("/api/network", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ enabled: true, remote: true });
  });
});

describe("sign-in and sessions", () => {
  beforeEach(enable);

  it("sets an HttpOnly, SameSite=Lax, 90-day cookie that unlocks the API and the UI socket", async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(new RegExp(`^codeden_session_${PORT}=cds_`));
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/Secure/i);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(89 * 86400);
    expect(maxAge).toBeLessThanOrEqual(90 * 86400);
    const cookie = cookieOf(res);
    expect((await phone("/api/snapshot", { headers: { cookie } })).status).toBe(200);
    expect((await phone("/ws", { headers: { cookie } })).status).toBe(200);
    const status = await statusOf(await local("/api/network", { headers: auth }));
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]).toMatchObject({ label: "Mozilla/5.0 (iPhone)", address: PHONE });
    // The device sees itself marked as current.
    const mine = await statusOf(await phone("/api/network", { headers: { cookie } }));
    expect(mine.devices[0]?.current).toBe(true);
  });

  it("marks the cookie Secure when served over HTTPS", async () => {
    const res = await app.request(
      `https://${LAN}:${PORT}/api/auth/sign-in`,
      {
        ...json({ password: GOOD }),
        headers: { "content-type": "application/json", host: `${LAN}:${PORT}` },
      },
      { incoming: { socket: { remoteAddress: PHONE } } },
    );
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("signs out one device, all devices, and on password change", async () => {
    const a = cookieOf(await signIn());
    const b = cookieOf(await signIn(GOOD, "192.168.1.31"));
    const out = await phone("/api/auth/sign-out", { method: "POST", headers: { cookie: a } });
    expect(out.status).toBe(200);
    expect((await phone("/api/snapshot", { headers: { cookie: a } })).status).toBe(401);
    expect((await phone("/api/snapshot", { headers: { cookie: b } })).status).toBe(200);

    const status = await statusOf(await local("/api/network", { headers: auth }));
    const id = status.devices[0]?.id as string;
    const del = await local(`/api/network/devices/${id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect((await phone("/api/snapshot", { headers: { cookie: b } })).status).toBe(401);
    expect(
      (await local("/api/network/devices/nope", { method: "DELETE", headers: auth })).status,
    ).toBe(404);

    const c = cookieOf(await signIn());
    const d = cookieOf(await signIn());
    const all = await local("/api/network/devices", { method: "DELETE", headers: auth });
    expect(all.status).toBe(200);
    for (const cookie of [c, d]) {
      expect((await phone("/api/snapshot", { headers: { cookie } })).status).toBe(401);
    }

    const e = cookieOf(await signIn());
    const dropped = listener.dropped;
    const change = await local("/api/network/password", {
      ...json({ password: "another fine sentence for the den" }, auth),
    });
    expect(change.status).toBe(200);
    expect(((await change.json()) as SetNetworkPasswordResponse).generated).toBeNull();
    expect((await phone("/api/snapshot", { headers: { cookie: e } })).status).toBe(401);
    expect(listener.dropped).toBeGreaterThan(dropped);
  });

  it("generates a passphrase once and refuses weak passwords", async () => {
    const res = await local("/api/network/password", json({ generate: true }, auth));
    const body = (await res.json()) as SetNetworkPasswordResponse;
    expect(body.generated).toMatch(/^[a-z]+(-[a-z]+){4}$/);
    expect(body.status.passwordSet).toBe(true);
    expect((await signIn(body.generated ?? "")).status).toBe(200);
    const weak = await local("/api/network/password", json({ password: "password1234567" }, auth));
    expect(weak.status).toBe(400);
    expect((await errorOf(weak)).error.code).toBe("weak_password");
  });

  it("throttles failed attempts per address and logs them without the password", async () => {
    for (let i = 0; i < 3; i++) expect((await signIn("wrong password, sorry")).status).toBe(401);
    const limited = await signIn("wrong password, sorry");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect((await errorOf(limited)).error.code).toBe("rate_limited");
    // Even the right password waits its turn.
    expect((await signIn()).status).toBe(429);
    // Another device is unaffected.
    expect((await signIn(GOOD, "192.168.1.77")).status).toBe(200);
    const log = readFileSync(join(dir, "remote-access.log"), "utf8");
    expect(log.match(/failed sign-in from 192\.168\.1\.30/g)).toHaveLength(3);
    expect(log).not.toContain("wrong password, sorry");
  });

  it("is refused from this machine and while network access is off", async () => {
    const res = await local("/api/auth/sign-in", json({ password: GOOD }));
    expect(res.status).toBe(403);
    await network.setEnabled(false);
    expect((await signIn()).status).toBe(403);
  });
});

describe("local requests", () => {
  it("keep working with the install token and see the network status", async () => {
    await enable();
    const res = await local("/api/network", { headers: auth });
    const body = await statusOf(res);
    expect(body).toMatchObject({
      enabled: true,
      passwordSet: true,
      listening: "network",
      remote: false,
    });
    expect(body.addresses.map((a) => a.url)).toEqual([
      `http://localhost:${PORT}`,
      `http://${LAN}:${PORT}`,
      `http://${TAILSCALE}:${PORT}`,
    ]);
    expect((await local("/api/snapshot")).status).toBe(401);
    expect(await (await local("/api/auth/status")).json()).toMatchObject({ remote: false });
  });

  it("can fetch the manifest and icons without a token", async () => {
    expect((await local("/manifest.webmanifest")).status).toBe(200);
    expect((await local("/icons/icon-192.png")).status).toBe(200);
  });
});

/**
 * A reverse proxy on this machine (Tailscale Serve): its connections come from 127.0.0.1 but
 * name the trusted origin's host, which must make them remote (§15.1).
 */
describe("trusted origin through a proxy on this machine", () => {
  const ORIGIN = "https://box.tail1234.ts.net:8445";
  const HOST = "box.tail1234.ts.net:8445";
  const proxied = (path: string, init: RequestInit & { host?: string; xff?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.xff) headers.set("x-forwarded-for", init.xff);
    if (!headers.has("origin") && init.method && init.method !== "GET")
      headers.set("origin", ORIGIN);
    return from("127.0.0.1", path, { ...init, headers, host: init.host ?? HOST });
  };
  const proxiedSignIn = (password = GOOD, xff = "100.64.0.7") =>
    proxied("/api/auth/sign-in", {
      ...json({ password }, { "user-agent": "Mozilla/5.0 (iPhone)" }),
      xff,
    });

  beforeEach(async () => {
    network.store.addTrustedOrigin(ORIGIN);
    await enable();
  });

  it("answers 401 sign_in_required without a session, and the API with one", async () => {
    const res = await proxied("/api/snapshot");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("sign_in_required");
    const cookie = cookieOf(await proxiedSignIn());
    expect(cookie).toMatch(/^codeden_session_/);
    expect((await proxied("/api/snapshot", { headers: { cookie } })).status).toBe(200);
    expect((await proxied("/ws", { headers: { cookie } })).status).toBe(200);
  });

  it("serves the UI shell and sign-in status to a signed-out device", async () => {
    expect((await proxied("/")).status).toBe(200);
    const status = (await (await proxied("/api/auth/status")).json()) as { remote: boolean };
    expect(status.remote).toBe(true);
  });

  it("never accepts the install token: header, cookie or ?token=", async () => {
    expect((await proxied("/api/snapshot", { headers: auth })).status).toBe(401);
    expect(
      (await proxied("/api/snapshot", { headers: { cookie: `codeden_token_${PORT}=${TOKEN}` } }))
        .status,
    ).toBe(401);
    expect((await proxied(`/api/snapshot?token=${TOKEN}`)).status).toBe(401);
    expect((await proxied("/ws", { headers: auth })).status).toBe(401);
    const page = await proxied(`/?token=${TOKEN}`);
    expect(page.status).toBe(200); // the public shell, no cookie, no redirect
    expect(page.headers.get("set-cookie")).toBeNull();
  });

  it("answers 404 for /mcp and the browser relay, even with a session", async () => {
    const cookie = cookieOf(await proxiedSignIn());
    for (const path of ["/mcp", "/api/browser/relay"]) {
      expect((await proxied(path, { headers: { cookie } })).status).toBe(404);
      expect((await proxied(path, { headers: auth })).status).toBe(404);
    }
  });

  it("can't change network access, trusted origins or the password", async () => {
    const cookie = cookieOf(await proxiedSignIn());
    const headers = { cookie, "content-type": "application/json" };
    const attempts: [string, string, unknown][] = [
      ["PUT", "/api/network", { enabled: false }],
      ["PUT", "/api/network", { loopbackOnly: true }],
      ["POST", "/api/network/password", { password: "another-long-passphrase-here" }],
      ["POST", "/api/network/origins", { url: "https://evil.example" }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await proxied(path, { method, headers, body: JSON.stringify(body) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(
      (
        await proxied(`/api/network/origins?url=${encodeURIComponent(ORIGIN)}`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(403);
    expect(network.store.trustedOrigins).toEqual([ORIGIN]);
    expect(network.enabled).toBe(true);
    // A device may see them.
    const seen = await statusOf(await proxied("/api/network", { headers: { cookie } }));
    expect(seen.trustedOrigins).toEqual([ORIGIN]);
    expect(seen.remote).toBe(true);
  });

  it("is refused with network access off, and grants nothing", async () => {
    await network.setEnabled(false);
    const res = await proxied("/api/snapshot", { headers: auth });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Network access is off");
    expect((await proxied("/")).status).toBe(403);
    expect((await proxiedSignIn()).status).toBe(403);
  });

  it("still refuses an untrusted *.ts.net host and unlisted ports", async () => {
    for (const host of [
      "evil.tail1234.ts.net:8445",
      "box.tail1234.ts.net",
      "box.tail1234.ts.net:9",
    ]) {
      const res = await proxied("/api/auth/status", { host });
      expect(res.status, host).toBe(403);
      expect(await res.text()).toBe("Forbidden host");
    }
  });

  it("refuses a trusted Origin with another Host, and another Origin with the trusted Host", async () => {
    const trustedOnLoopback = await local("/api/auth/status", { headers: { origin: ORIGIN } });
    expect(trustedOnLoopback.status).toBe(403);
    expect(await trustedOnLoopback.text()).toBe("Forbidden origin");
    const trustedOnLan = await phone("/api/auth/status", { headers: { origin: ORIGIN } });
    expect(trustedOnLan.status).toBe(403);
    for (const origin of [
      `http://127.0.0.1:${PORT}`,
      `http://${HOST}`,
      "null",
      "https://evil.example",
    ]) {
      const res = await proxied("/api/auth/status", { headers: { origin } });
      expect(res.status, origin).toBe(403);
    }
    expect((await proxied("/api/auth/status", { headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it("matches the host case-insensitively and a default port as :443", async () => {
    network.store.addTrustedOrigin("https://plain.tail1234.ts.net");
    expect((await proxied("/api/auth/status", { host: "PLAIN.tail1234.TS.net" })).status).toBe(200);
    expect((await proxied("/api/auth/status", { host: "plain.tail1234.ts.net:443" })).status).toBe(
      200,
    );
    expect((await proxied("/api/auth/status", { host: "BOX.tail1234.ts.net:8445" })).status).toBe(
      200,
    );
  });

  it("sets a Secure cookie from the matched origin, though the request URL is http", async () => {
    const res = await proxiedSignIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    // Not Secure when it came by the LAN address.
    expect((await signIn()).headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("throttles per forwarded address, not per the proxy's 127.0.0.1", async () => {
    for (let i = 0; i < 3; i++)
      expect((await proxiedSignIn("wrong password, sorry")).status).toBe(401);
    expect((await proxiedSignIn(GOOD)).status).toBe(429);
    // Another device behind the same proxy is unaffected.
    expect((await proxiedSignIn(GOOD, "100.64.0.8")).status).toBe(200);
  });

  it("stops attempts that rotate X-Forwarded-For with one shared limit", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await proxiedSignIn("wrong password, sorry", `100.64.1.${i}`)).status).toBe(401);
    }
    const next = await proxiedSignIn(GOOD, "100.64.9.9");
    expect(next.status).toBe(429);
    expect((await errorOf(next)).error.code).toBe("rate_limited");
    // The limit is for the proxy path only: a direct sign-in is unaffected.
    expect((await signIn(GOOD, "192.168.1.50")).status).toBe(200);
  });

  it("ignores X-Forwarded-For on requests that did not come through the proxy", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await from(PHONE, "/api/auth/sign-in", {
        host: `${LAN}:${PORT}`,
        ...json({ password: "wrong password, sorry" }, { "x-forwarded-for": `100.64.2.${i}` }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await from(PHONE, "/api/auth/sign-in", {
      host: `${LAN}:${PORT}`,
      ...json({ password: GOOD }, { "x-forwarded-for": "100.64.2.99" }),
    });
    expect(limited.status).toBe(429);
    // And a local request with that header is not remote.
    expect(
      (await local("/api/snapshot", { headers: { ...auth, "x-forwarded-for": "1.2.3.4" } })).status,
    ).toBe(200);
  });

  it("shows the forwarded address as proxy-reported in devices and the log", async () => {
    await proxiedSignIn("wrong password, sorry", "100.64.3.3");
    await proxiedSignIn(GOOD, "100.64.3.4");
    const status = await statusOf(await local("/api/network", { headers: auth }));
    expect(status.devices[0]).toMatchObject({ address: "100.64.3.4", addressViaProxy: true });
    const log = readFileSync(join(dir, "remote-access.log"), "utf8");
    expect(log).toContain("failed sign-in from 100.64.3.3 (reported by proxy)");
    // A missing or bogus header is recorded as unknown, never as the proxy's 127.0.0.1.
    await proxiedSignIn("wrong password, sorry", "not-an-ip");
    expect(readFileSync(join(dir, "remote-access.log"), "utf8")).toContain(
      "from unknown (reported by proxy)",
    );
  });

  it("puts wss:// for the trusted host in connect-src", async () => {
    const csp = (await proxied("/csp")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`wss://${HOST}`);
  });

  it("is an ordinary loopback host again once the origin is removed", async () => {
    network.store.removeTrustedOrigin(ORIGIN);
    const res = await proxied("/api/snapshot", { headers: auth });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden host");
  });

  it("reserves the shared limit while a password is being checked", async () => {
    let finish: (ok: boolean) => void = () => {};
    let calls = 0;
    network.store.checkPassword = () => {
      calls++;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    };
    const first = proxiedSignIn("anything at all", "100.64.5.1");
    await vi.waitFor(() => expect(calls).toBe(1));
    // Other devices behind the proxy, and the same one again, wait: no second check starts.
    for (const xff of ["100.64.5.2", "100.64.5.3", "100.64.5.1"]) {
      const res = await proxiedSignIn(GOOD, xff);
      expect(res.status, xff).toBe(429);
    }
    expect(calls).toBe(1);
    finish(false);
    expect((await first).status).toBe(401);
    // The reservation is released: the next attempt runs.
    const next = proxiedSignIn(GOOD, "100.64.5.2");
    await vi.waitFor(() => expect(calls).toBe(2));
    finish(true);
    expect((await next).status).toBe(200);
  });

  it("releases the reservation when the check throws", async () => {
    network.store.checkPassword = () => Promise.reject(new Error("boom"));
    expect((await proxiedSignIn(GOOD, "100.64.6.1")).status).toBe(500);
    network.store.checkPassword = async () => true;
    expect((await proxiedSignIn(GOOD, "100.64.6.2")).status).toBe(200);
  });
});

describe("network policy changes", () => {
  it("run one at a time, and a failed bind puts the saved policy back", async () => {
    await network.setPassword({ password: GOOD });
    const order: string[] = [];
    let release: () => void = () => {};
    listener.rebind = async (host: BindHost) => {
      order.push(`start ${host}`);
      if (order.length === 1) await new Promise<void>((r) => (release = r));
      listener.host = host;
      order.push(`end ${host}`);
    };
    const wide = network.update({ enabled: true });
    const narrow = network.update({ loopbackOnly: true });
    await vi.waitFor(() => expect(order).toEqual(["start 0.0.0.0"]));
    release();
    await Promise.all([wide, narrow]);
    expect(order).toEqual(["start 0.0.0.0", "end 0.0.0.0", "start 127.0.0.1", "end 127.0.0.1"]);
    expect(network.store.policy).toEqual({ enabled: true, loopbackOnly: true });
    expect(listener.host).toBe("127.0.0.1");

    listener.rebind = async (host: BindHost) => {
      if (host === "0.0.0.0") throw new Error("EADDRINUSE");
      listener.host = host;
    };
    await expect(network.update({ loopbackOnly: false })).rejects.toThrow("EADDRINUSE");
    expect(network.store.policy).toEqual({ enabled: true, loopbackOnly: true });
    expect(network.desiredHost()).toBe(listener.host);
  });
});
