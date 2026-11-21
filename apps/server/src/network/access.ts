import { appendFileSync } from "node:fs";
import type { NetworkAddress, NetworkStatus } from "@codeden/contracts";
import { type InterfaceMap, listAddresses } from "./addresses";
import type { BindHost, HttpListener } from "./listener";
import { generatePassphrase } from "./password";
import { type SignInGate, SignInLimiter } from "./rate-limit";
import type { RemoteAccessStore } from "./store";

/** Interface addresses are re-read at most this often (Host/Origin checks run per request). */
const ADDRESS_CACHE_MS = 5_000;

/** Who is signing in: the socket's peer, or the address a trusted proxy reported for the device. */
export interface SignInClient {
  address: string;
  /** The address came from the proxy's `X-Forwarded-For`; the peer itself is 127.0.0.1. */
  viaProxy: boolean;
}

/** Sign-ins through the trusted proxy share this one allowance (a local process can fake any `X-Forwarded-For`). */
const SHARED_PROXY_FREE_FAILURES = 10;
const SHARED_PROXY_LOCKOUT_FAILURES = 30;

export interface NetworkAccessOptions {
  store: RemoteAccessStore;
  listener: HttpListener;
  /** Network interfaces; injectable for tests. */
  interfaces?: () => InterfaceMap;
  /** Clock for the sign-in limiter. */
  now?: () => number;
  /** Failed sign-ins are appended here (never the password). */
  securityLogFile?: string;
  log?: (message: string) => void;
}

/**
 * Network access (§15.1): owns the switch, the password, remote sessions, the sign-in limiter
 * and where the HTTP listener is bound. Turning access on moves the listener to `0.0.0.0`
 * (same port); off moves it back to `127.0.0.1` and drops remote connections. The runner is
 * never involved.
 */
export class NetworkAccess {
  readonly store: RemoteAccessStore;
  readonly limiter: SignInLimiter;
  /** One limit for every sign-in that came through the trusted proxy together. */
  readonly proxyLimiter: SignInLimiter;
  private readonly listener: HttpListener;
  private readonly interfaces: () => InterfaceMap | undefined;
  private readonly log: (message: string) => void;
  private cached: { at: number; port: number; addresses: NetworkAddress[] } | undefined;

  constructor(private readonly opts: NetworkAccessOptions) {
    this.store = opts.store;
    this.listener = opts.listener;
    this.interfaces = opts.interfaces ?? (() => undefined);
    this.limiter = new SignInLimiter(opts.now);
    this.proxyLimiter = new SignInLimiter(opts.now, {
      freeFailures: SHARED_PROXY_FREE_FAILURES,
      lockoutFailures: SHARED_PROXY_LOCKOUT_FAILURES,
    });
    this.log = opts.log ?? (() => {});
  }

  /** On only when switched on *and* a password is set: never bind beyond loopback without one. */
  get enabled(): boolean {
    return this.store.enabled && this.store.passwordSet;
  }

  /** Where the listener should be bound: wide only when on and not kept to loopback. */
  desiredHost(): BindHost {
    return this.enabled && !this.store.loopbackOnly ? "0.0.0.0" : "127.0.0.1";
  }

  /**
   * May this client try a password now? An allowed result reserves the client's key (and, for
   * a proxied client, the one shared key) for the check: call `release` when it is done,
   * whatever the outcome. Overlapping checks for one key, or through the proxy at all, wait.
   */
  beginSignIn(client: SignInClient): { gate: SignInGate; release: () => void } {
    const key = this.limiterKey(client);
    const own = this.limiter.acquire(key);
    if (!own.allowed) return { gate: own, release: () => {} };
    if (!client.viaProxy) return { gate: own, release: () => this.limiter.release(key) };
    const shared = this.proxyLimiter.acquire("proxy");
    if (!shared.allowed) {
      this.limiter.release(key);
      return { gate: shared, release: () => {} };
    }
    return {
      gate: shared,
      release: () => {
        this.limiter.release(key);
        this.proxyLimiter.release("proxy");
      },
    };
  }

  failSignIn(client: SignInClient): void {
    this.limiter.fail(this.limiterKey(client));
    if (client.viaProxy) this.proxyLimiter.fail("proxy");
  }

  /** A correct password clears the device's own failures, never the shared count. */
  succeedSignIn(client: SignInClient): void {
    this.limiter.succeed(this.limiterKey(client));
  }

  private limiterKey(client: SignInClient): string {
    return client.viaProxy ? `proxy:${client.address || "unknown"}` : client.address;
  }

  get port(): number {
    return this.listener.port;
  }

  /** Every address the server would answer on (localhost first), cached briefly. */
  candidates(): NetworkAddress[] {
    const now = Date.now();
    const port = this.listener.port;
    if (!this.cached || this.cached.port !== port || now - this.cached.at > ADDRESS_CACHE_MS) {
      this.cached = { at: now, port, addresses: listAddresses(port, this.interfaces()) };
    }
    return this.cached.addresses;
  }

  /** Addresses it answers on now: localhost only while off. */
  addresses(): NetworkAddress[] {
    const all = this.candidates();
    return this.listener.host === "0.0.0.0" ? all : all.filter((a) => a.kind === "local");
  }

  /** The machine's own LAN/VPN hosts accepted in `Host` and `Origin` while access is on. */
  ownHosts(): ReadonlySet<string> {
    if (!this.enabled || this.listener.host !== "0.0.0.0") return new Set();
    return new Set(
      this.candidates()
        .filter((a) => a.kind !== "local")
        .map((a) => a.host),
    );
  }

  status(caller: { remote: boolean; sessionId?: string | null }): NetworkStatus {
    return {
      enabled: this.enabled,
      passwordSet: this.store.passwordSet,
      passwordSetAt: this.store.passwordSetAt,
      listening: this.listener.host === "0.0.0.0" ? "network" : "loopback",
      loopbackOnly: this.store.loopbackOnly,
      trustedOrigins: [...this.store.trustedOrigins],
      port: this.listener.port,
      addresses: this.addresses(),
      candidates: this.candidates(),
      devices: this.store.liveSessions().map((s) => ({
        id: s.id,
        label: s.label,
        address: s.address,
        addressViaProxy: s.addressViaProxy,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        current: s.id === caller.sessionId,
      })),
      remote: caller.remote,
    };
  }

  /** Turn network access on (needs a password) or off, and move the listener to match. */
  setEnabled(enabled: boolean): Promise<void> {
    return this.update({ enabled });
  }

  /** Keep the listener on 127.0.0.1 while access is on, or let it go wide again. */
  setLoopbackOnly(loopbackOnly: boolean): Promise<void> {
    return this.update({ loopbackOnly });
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Run `task` after every earlier policy change and bind has finished. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Save the switch and/or loopback-only and bind the listener to match, as one step that
   * waits for any earlier one. If the bind fails the saved policy is put back (the listener
   * falls back to loopback), so what is stored and where it listens never disagree for long.
   */
  update(change: { enabled?: boolean; loopbackOnly?: boolean }): Promise<void> {
    return this.serial(async () => {
      const before = this.store.policy;
      this.store.setPolicy(change);
      try {
        await this.bindNow();
      } catch (error) {
        this.store.restorePolicy(before);
        await this.bindNow().catch(() => {});
        throw error;
      }
    });
  }

  /** Bind the listener where the stored settings say; drops remote connections when off. */
  applyBinding(): Promise<void> {
    return this.serial(() => this.bindNow());
  }

  private async bindNow(): Promise<void> {
    const host = this.desiredHost();
    await this.listener.rebind(host);
    this.cached = undefined;
    if (host === "127.0.0.1") this.listener.dropRemote();
    this.log(
      host === "0.0.0.0"
        ? `network access on: ${this.addresses()
            .map((a) => a.url)
            .join(", ")}`
        : this.enabled
          ? "network access on, loopback only: listening on 127.0.0.1 for the trusted proxy"
          : "network access off: listening on 127.0.0.1 only",
    );
  }

  /** Set (or generate) the password; signs out every remote device. Returns a generated one. */
  async setPassword(input: { password: string } | { generate: true }): Promise<string | null> {
    const generated = "generate" in input ? generatePassphrase() : null;
    await this.store.setPassword(generated ?? (input as { password: string }).password);
    this.listener.dropRemote();
    this.log("network access password changed: every remote device was signed out");
    return generated;
  }

  /** Close connections that came through the trusted proxy. */
  dropProxied(): void {
    this.listener.dropRemote();
  }

  /** Sign out one device (and close remote connections so it notices). */
  revoke(id: string): boolean {
    const revoked = this.store.revoke(id);
    if (revoked) this.listener.dropRemote();
    return revoked;
  }

  revokeAll(): void {
    this.store.revokeAll();
    this.listener.dropRemote();
  }

  /** Note a failed sign-in with its address (the password is never logged). */
  recordFailedSignIn(address: string, reason: string, viaProxy = false): void {
    const from = `${address || "unknown"}${viaProxy ? " (reported by proxy)" : ""}`;
    const line = `${new Date().toISOString()} failed sign-in from ${from}: ${reason}`;
    this.log(`network: ${line}`);
    if (this.opts.securityLogFile) {
      try {
        appendFileSync(this.opts.securityLogFile, `${line}\n`, { mode: 0o600 });
      } catch {
        // Logging must never break sign-in handling.
      }
    }
  }
}
