import {
  AddTrustedOriginRequest,
  type AuthStatus,
  SetNetworkAccessRequest,
  SetNetworkPasswordRequest,
  type SetNetworkPasswordResponse,
  type SignInError,
  SignInRequest,
} from "@codeden/contracts";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { NetworkAccess } from "../network/access";
import { PasswordRuleError, TrustedOriginError } from "../network/store";
import { isRemoteRequest, peerAddress, proxyClientOf, trustedOriginOf } from "../security";
import { badRequest, forbidden, notFound } from "../services/errors";
import { tokensEqual } from "../token";
import { jsonBody } from "./validate";

export interface NetworkRouteContext {
  network: NetworkAccess;
  /** Remote session cookie name (includes the port). */
  sessionCookie: () => string;
  /** Install-token cookie name, to tell whether a local browser is signed in. */
  tokenCookie: () => string;
  token: string;
}

/** Session id of a remote caller, from its cookie. */
function remoteSessionId(c: Context, ctx: NetworkRouteContext): string | null {
  return ctx.network.store.verifySession(getCookie(c, ctx.sessionCookie()))?.id ?? null;
}

/** Changing network access is for this machine only (and the CLI). */
function requireLocal(c: Context): void {
  if (isRemoteRequest(c)) {
    throw forbidden("Network access can only be changed on the computer running CodeDen.");
  }
}

/**
 * `/api/network` (§15.1): status for everyone signed in; turning access on or off and the
 * password are loopback-only. Signed-in devices can be signed out from anywhere.
 */
export function networkRoutes(ctx: NetworkRouteContext) {
  const { network } = ctx;
  const statusFor = (c: Context) =>
    network.status({ remote: isRemoteRequest(c), sessionId: remoteSessionId(c, ctx) });
  return new Hono()
    .get("/", (c) => c.json(statusFor(c)))
    .put("/", jsonBody(SetNetworkAccessRequest), async (c) => {
      requireLocal(c);
      const { enabled, loopbackOnly } = c.req.valid("json");
      if (enabled && !network.store.passwordSet) {
        throw badRequest("Set a password before turning network access on.", "password_required");
      }
      // One serialized step: save both choices, then move the listener once.
      await network.update({ enabled, loopbackOnly });
      return c.json(statusFor(c));
    })
    .post("/origins", jsonBody(AddTrustedOriginRequest), (c) => {
      requireLocal(c);
      try {
        network.store.addTrustedOrigin(c.req.valid("json").url);
      } catch (error) {
        if (error instanceof TrustedOriginError) throw badRequest(error.message, error.code);
        throw error;
      }
      return c.json(statusFor(c));
    })
    .delete("/origins", (c) => {
      requireLocal(c);
      const url = c.req.query("url") ?? "";
      if (!network.store.removeTrustedOrigin(url)) throw notFound("No such trusted origin");
      // Whoever signed in through it keeps a cookie that no longer reaches anything.
      network.dropProxied();
      return c.json(statusFor(c));
    })
    .post("/password", jsonBody(SetNetworkPasswordRequest), async (c) => {
      requireLocal(c);
      let generated: string | null;
      try {
        generated = await network.setPassword(c.req.valid("json"));
      } catch (error) {
        if (error instanceof PasswordRuleError) throw badRequest(error.message, error.code);
        throw error;
      }
      const body: SetNetworkPasswordResponse = { status: statusFor(c), generated };
      return c.json(body);
    })
    .delete("/devices/:id", (c) => {
      if (!network.revoke(c.req.param("id"))) throw notFound("No such device");
      return c.json(statusFor(c));
    })
    .delete("/devices", (c) => {
      network.revokeAll();
      return c.json(statusFor(c));
    });
}

/** `/api/auth` (§15.1): sign-in for remote devices. Public; Host/Origin checks still apply. */
export function authRoutes(ctx: NetworkRouteContext) {
  const { network } = ctx;
  return new Hono()
    .get("/status", (c) => {
      const remote = isRemoteRequest(c);
      const body: AuthStatus = {
        remote,
        signedIn: remote
          ? remoteSessionId(c, ctx) !== null
          : tokensEqual(getCookie(c, ctx.tokenCookie()), ctx.token),
        networkEnabled: network.enabled,
      };
      return c.json(body);
    })
    .post("/sign-in", jsonBody(SignInRequest), async (c) => {
      const proxy = proxyClientOf(c);
      const client = proxy
        ? { address: proxy.address ?? "", viaProxy: true }
        : { address: peerAddress(c), viaProxy: false };
      const address = client.address;
      const refuse = (
        status: 401 | 403 | 429,
        code: SignInError["error"]["code"],
        message: string,
        retryAfterMs: number | null = null,
      ) => {
        const retryAfterSec = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
        if (retryAfterSec !== null) c.header("Retry-After", String(retryAfterSec));
        const body: SignInError = { error: { code, message, retryAfterSec } };
        return c.json(body, status);
      };
      if (!network.enabled) return refuse(403, "network_off", "Network access is off.");
      if (!isRemoteRequest(c)) {
        return refuse(
          403,
          "network_off",
          "Sign-in is for other devices; this computer uses its own link.",
        );
      }
      const { gate, release } = network.beginSignIn(client);
      if (!gate.allowed) {
        const seconds = Math.ceil(gate.retryAfterMs / 1000);
        return gate.reason === "locked_out"
          ? refuse(
              429,
              "locked_out",
              `Too many wrong passwords. Try again in ${Math.ceil(seconds / 60)} min.`,
              gate.retryAfterMs,
            )
          : refuse(
              429,
              "rate_limited",
              `Wait ${seconds} s before trying again.`,
              gate.retryAfterMs,
            );
      }
      const { password } = c.req.valid("json");
      // The reservation lasts through the (slow) check and the failure it may record.
      try {
        if (!(await network.store.checkPassword(password))) {
          network.failSignIn(client);
          network.recordFailedSignIn(address, "wrong password", client.viaProxy);
          return refuse(401, "invalid_password", "That password is not right.");
        }
        network.succeedSignIn(client);
      } finally {
        release();
      }
      const { token, session } = network.store.createSession({
        label: c.req.header("user-agent") ?? "",
        address: address || null,
        addressViaProxy: client.viaProxy && address !== "",
      });
      setCookie(c, ctx.sessionCookie(), token, {
        httpOnly: true,
        sameSite: "Lax",
        // Behind a proxy the request URL is http; the matched trusted origin says what the browser used.
        secure:
          trustedOriginOf(c)?.startsWith("https://") ?? new URL(c.req.url).protocol === "https:",
        path: "/",
        maxAge: Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
      });
      return c.json({ ok: true as const });
    })
    .post("/sign-out", (c) => {
      const id = remoteSessionId(c, ctx);
      if (id) network.store.revoke(id);
      deleteCookie(c, ctx.sessionCookie(), { path: "/" });
      return c.json({ ok: true as const });
    });
}
