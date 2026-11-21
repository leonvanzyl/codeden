import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkStatus } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

/**
 * Network access against a real server: the listener moves between 127.0.0.1 and 0.0.0.0 on
 * the same port. When this machine has a LAN IPv4 address, connecting to it from here makes
 * the server see a non-loopback peer, which is a real remote request.
 */
const TOKEN = "n".repeat(64);
const GOOD = "maple-river-quiet-orbit-candle";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))?.address;

let home: string;
let server: RunningServer | undefined;

const start = () =>
  startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-netsrv-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await removeTree(home);
});

async function api(path: string, init: RequestInit = {}) {
  const s = server as RunningServer;
  return fetch(`${s.url}${path}`, { ...init, headers: { ...auth, ...init.headers } });
}

describe("network access on a real server", () => {
  it("binds 127.0.0.1 by default and refuses to go wider without a password", async () => {
    server = await start();
    const status = (await (await api("/api/network")).json()) as NetworkStatus;
    expect(status).toMatchObject({ enabled: false, passwordSet: false, listening: "loopback" });
    expect(status.addresses).toHaveLength(1);
    const on = await api("/api/network", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(400);
    expect(server.network.desiredHost()).toBe("127.0.0.1");
  });

  it("stays on loopback at startup when the file says on but has no password", async () => {
    writeFileSync(join(home, "remote-access.json"), JSON.stringify({ enabled: true }));
    server = await start();
    expect(server.network.enabled).toBe(false);
    expect(await (await api("/api/network")).json()).toMatchObject({ listening: "loopback" });
  });

  it("moves the listener to 0.0.0.0 on the same port and back, keeping local connections", async () => {
    server = await start();
    const port = server.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: auth.authorization },
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    expect(
      (
        await api("/api/network/password", {
          method: "POST",
          body: JSON.stringify({ password: GOOD }),
        })
      ).status,
    ).toBe(200);
    const on = await api("/api/network", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ enabled: true, listening: "network", port });
    expect(server.port).toBe(port);
    // The UI socket opened before the switch is still connected.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect((await api("/api/health")).status).toBe(200);

    const off = await api("/api/network", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(await off.json()).toMatchObject({ enabled: false, listening: "loopback" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it.skipIf(!lanAddress)("signs in a real remote peer on the LAN address", async () => {
    server = await start();
    const port = server.port;
    await api("/api/network/password", {
      method: "POST",
      body: JSON.stringify({ password: GOOD }),
    });
    await api("/api/network", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const remote = `http://${lanAddress}:${port}`;

    // Signed out: the UI shell loads, the API asks for a sign-in, /mcp does not exist.
    expect((await fetch(`${remote}/`)).status).toBe(200);
    const locked = await fetch(`${remote}/api/snapshot`, {
      headers: { authorization: auth.authorization },
    });
    expect(locked.status).toBe(401);
    expect((await fetch(`${remote}/mcp`, { method: "POST" })).status).toBe(404);

    const signIn = await fetch(`${remote}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: remote, "user-agent": "E2E phone" },
      body: JSON.stringify({ password: GOOD }),
    });
    expect(signIn.status).toBe(200);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect((await fetch(`${remote}/api/snapshot`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${remote}/mcp`, { method: "POST", headers: { cookie } })).status).toBe(
      404,
    );

    const ws = new WebSocket(`ws://${lanAddress}:${port}/ws`, {
      headers: { cookie, origin: remote },
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise((resolve) => ws.once("close", resolve));

    // Signing everyone out closes the remote socket; the cookie no longer works.
    await api("/api/network/devices", { method: "DELETE" });
    await closed;
    expect((await fetch(`${remote}/api/snapshot`, { headers: { cookie } })).status).toBe(401);

    // Off: nothing answers on the LAN address any more.
    await api("/api/network", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    await expect(fetch(`${remote}/api/health`)).rejects.toThrow();
  });

  describe("behind a reverse proxy on this machine", () => {
    const HOST = "box.tail1234.ts.net:8445";
    const ORIGIN = "https://box.tail1234.ts.net:8445";
    const post = (path: string, body: unknown) =>
      api(path, { method: "POST", body: JSON.stringify(body) });
    const put = (body: unknown) =>
      api("/api/network", { method: "PUT", body: JSON.stringify(body) });

    /** A request from this machine that names the proxy's host, as Tailscale Serve sends it. */
    const viaProxy = (
      path: string,
      headers: Record<string, string> = {},
      send?: { method: string; body: string },
    ) =>
      new Promise<{ status: number; body: string; setCookie: string[] }>((resolve, reject) => {
        const s = server as RunningServer;
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: s.port,
            path,
            method: send?.method ?? "GET",
            headers: { host: HOST, ...headers },
          },
          (res) => {
            let body = "";
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                setCookie: res.headers["set-cookie"] ?? [],
              }),
            );
          },
        );
        req.once("error", reject);
        req.end(send?.body);
      });

    it("keeps the listener on 127.0.0.1 with access on, and reports it", async () => {
      server = await start();
      await post("/api/network/password", { password: GOOD });
      const on = await put({ enabled: true, loopbackOnly: true });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({
        enabled: true,
        loopbackOnly: true,
        listening: "loopback",
      });
      expect(server.network.desiredHost()).toBe("127.0.0.1");
      if (lanAddress) {
        await expect(fetch(`http://${lanAddress}:${server.port}/api/health`)).rejects.toThrow();
      }
      // Turning the choice off goes wide again; it is remembered across restarts.
      expect(await (await put({ loopbackOnly: false })).json()).toMatchObject({
        listening: "network",
      });
      await put({ loopbackOnly: true });
      await server.close();
      server = await start();
      expect(await (await api("/api/network")).json()).toMatchObject({
        enabled: true,
        loopbackOnly: true,
        listening: "loopback",
      });
    });

    it("keeps the stored policy and the socket in step when changes overlap", async () => {
      server = await start();
      await post("/api/network/password", { password: GOOD });
      await put({ enabled: true });
      const flips = [true, false, true, false, true, true, false, true];
      // Straight at the access object: HTTP clients would race the socket swap itself.
      await Promise.all(flips.map((loopbackOnly) => server?.network.update({ loopbackOnly })));
      const status = (await (await api("/api/network")).json()) as NetworkStatus;
      expect(status.loopbackOnly).toBe(true);
      expect(status.listening).toBe("loopback");
      expect(server.network.desiredHost()).toBe("127.0.0.1");
      if (lanAddress) {
        await expect(fetch(`http://${lanAddress}:${server.port}/api/health`)).rejects.toThrow();
      }
      await Promise.all(
        [false, true, false].map((loopbackOnly) => server?.network.update({ loopbackOnly })),
      );
      const wide = (await (await api("/api/network")).json()) as NetworkStatus;
      expect(wide).toMatchObject({ loopbackOnly: false, listening: "network" });
    });

    it("lists, adds and removes trusted origins on this machine only, validating them", async () => {
      server = await start();
      const added = await post("/api/network/origins", { url: "https://Box.Tail1234.ts.net:8445" });
      expect(await added.json()).toMatchObject({ trustedOrigins: [ORIGIN] });
      for (const url of ["http://box.ts.net", "https://box.ts.net/x", "https://127.0.0.1"]) {
        expect((await post("/api/network/origins", { url })).status, url).toBe(400);
      }
      expect(
        (
          await api(`/api/network/origins?url=${encodeURIComponent("https://other.ts.net")}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(404);
      const removed = await api(`/api/network/origins?url=${encodeURIComponent(ORIGIN)}`, {
        method: "DELETE",
      });
      expect(await removed.json()).toMatchObject({ trustedOrigins: [] });
    });

    it("answers a trusted host 401 without a session, 403 when access is off, never the token", async () => {
      server = await start();
      await post("/api/network/password", { password: GOOD });
      await post("/api/network/origins", { url: ORIGIN });
      const bearer = { authorization: auth.authorization };

      // Access off: trusted origins grant nothing.
      expect((await viaProxy("/api/snapshot", bearer)).status).toBe(403);

      await put({ enabled: true, loopbackOnly: true });
      const noSession = await viaProxy("/api/snapshot");
      expect(noSession.status).toBe(401);
      expect(JSON.parse(noSession.body).error.code).toBe("sign_in_required");
      expect((await viaProxy("/api/snapshot", bearer)).status).toBe(401);
      expect((await viaProxy(`/api/snapshot?token=${TOKEN}`)).status).toBe(401);
      expect((await viaProxy("/mcp")).status).toBe(404);
      expect((await viaProxy("/api/network", { ...bearer, origin: ORIGIN })).status).toBe(401);
      // The same server answers this machine with the token as before.
      expect((await api("/api/snapshot")).status).toBe(200);
    });

    it("needs a session for the UI socket through the trusted host, and drops it on sign-out", async () => {
      server = await start();
      await post("/api/network/password", { password: GOOD });
      await post("/api/network/origins", { url: ORIGIN });
      await put({ enabled: true, loopbackOnly: true });
      const url = `ws://127.0.0.1:${server.port}/ws`;

      const refused = await new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers: { host: HOST, origin: ORIGIN } });
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => resolve(101));
        ws.once("error", () => {});
      });
      expect(refused).toBe(401);
      // The install token doesn't open it either.
      const withToken = await new Promise<number>((resolve) => {
        const ws = new WebSocket(url, {
          headers: { host: HOST, origin: ORIGIN, authorization: auth.authorization },
        });
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => resolve(101));
        ws.once("error", () => {});
      });
      expect(withToken).toBe(401);

      const signIn = await viaProxy(
        "/api/auth/sign-in",
        { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": "100.64.0.9" },
        { method: "POST", body: JSON.stringify({ password: GOOD }) },
      );
      expect(signIn.status).toBe(200);
      expect(signIn.setCookie.join()).toMatch(/Secure/);
      const cookie = (signIn.setCookie[0] ?? "").split(";")[0] as string;
      const ws = new WebSocket(url, { headers: { host: HOST, origin: ORIGIN, cookie } });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise((resolve) => ws.once("close", resolve));
      const status = (await (await api("/api/network")).json()) as NetworkStatus;
      expect(status.devices[0]).toMatchObject({ address: "100.64.0.9", addressViaProxy: true });

      // Signing out closes the proxied socket too: its peer is 127.0.0.1.
      await api("/api/network/devices", { method: "DELETE" });
      await closed;
    });
  });
});
