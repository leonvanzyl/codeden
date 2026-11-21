import {
  AuthStatus,
  type NetworkAddress,
  NetworkStatus,
  passwordProblem,
  SetNetworkPasswordResponse,
  SignInError,
} from "@codeden/contracts";
import { ApiRequestError, type Fetcher } from "./http";

/** Network access (§15.1): the switch, the password and signed-in devices. */
export interface NetworkApi {
  status(): Promise<NetworkStatus>;
  /** Turn network access on (needs a password) or off. This computer only. */
  setEnabled(enabled: boolean): Promise<NetworkStatus>;
  /** Keep the listener on 127.0.0.1 while access is on (a proxy on this computer fronts it). */
  setLoopbackOnly(loopbackOnly: boolean): Promise<NetworkStatus>;
  /** Set a password, or generate one (returned once). Signs out every remote device. */
  setPassword(
    input: { password: string } | { generate: true },
  ): Promise<SetNetworkPasswordResponse>;
  signOutDevice(id: string): Promise<NetworkStatus>;
  signOutAll(): Promise<NetworkStatus>;
}

/** Sign-in for remote devices. These calls never trigger the "signed out" screen. */
export interface AuthApi {
  status(): Promise<AuthStatus>;
  /** Resolves on success; rejects with a `SignInFailure` otherwise. */
  signIn(password: string): Promise<void>;
  signOut(): Promise<void>;
}

/** A refused sign-in, with how long to wait when the address is throttled. */
export class SignInFailure extends Error {
  constructor(
    readonly code: SignInError["error"]["code"] | "network",
    message: string,
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = "SignInFailure";
  }
}

export function httpNetworkApi(http: Fetcher): NetworkApi {
  const parse = (v: unknown) => NetworkStatus.parse(v);
  return {
    status: () => http.get("/network", parse),
    setEnabled: (enabled) => http.call("PUT", "/network", { enabled }, parse),
    setLoopbackOnly: (loopbackOnly) => http.call("PUT", "/network", { loopbackOnly }, parse),
    setPassword: (input) =>
      http.post("/network/password", input, (v) => SetNetworkPasswordResponse.parse(v)),
    signOutDevice: (id) =>
      http.call("DELETE", `/network/devices/${encodeURIComponent(id)}`, undefined, parse),
    signOutAll: () => http.call("DELETE", "/network/devices", undefined, parse),
  };
}

/** Plain fetches: a 401 here means "wrong password", not "signed out". */
export function httpAuthApi(origin: string): AuthApi {
  const base = `${origin}/api/auth`;
  return {
    async status() {
      const res = await fetch(`${base}/status`, { credentials: "include" });
      return AuthStatus.parse(await res.json());
    },
    async signIn(password) {
      let res: Response;
      try {
        res = await fetch(`${base}/sign-in`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      } catch {
        throw new SignInFailure("network", "Can't reach CodeDen. Is the computer awake?", null);
      }
      if (res.ok) return;
      const body = SignInError.safeParse(await res.json().catch(() => null));
      if (body.success) {
        const { code, message, retryAfterSec } = body.data.error;
        throw new SignInFailure(code, message, retryAfterSec);
      }
      throw new ApiRequestError(res.status, "http_error", `Sign-in failed (${res.status})`);
    },
    async signOut() {
      await fetch(`${base}/sign-out`, { method: "POST", credentials: "include" });
    },
  };
}

const MOCK_ADDRESSES: NetworkAddress[] = [
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
];

/** In-memory network access for the mock client: one signed-in phone, password not set. */
export function mockNetworkApi(): NetworkApi {
  const now = Date.now();
  let status: NetworkStatus = {
    enabled: false,
    passwordSet: false,
    passwordSetAt: null,
    listening: "loopback",
    loopbackOnly: false,
    trustedOrigins: [],
    port: 4317,
    addresses: MOCK_ADDRESSES.slice(0, 1),
    candidates: MOCK_ADDRESSES,
    devices: [
      {
        id: "dev-phone",
        label: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) Safari/605.1.15",
        address: "192.168.1.31",
        addressViaProxy: false,
        createdAt: new Date(now - 3 * 86_400_000).toISOString(),
        lastSeenAt: new Date(now - 4 * 60_000).toISOString(),
        expiresAt: new Date(now + 87 * 86_400_000).toISOString(),
        current: false,
      },
    ],
    remote: false,
  };
  const set = (patch: Partial<NetworkStatus>) => {
    status = { ...status, ...patch };
    const wide = status.enabled && !status.loopbackOnly;
    status.addresses = wide ? MOCK_ADDRESSES : MOCK_ADDRESSES.slice(0, 1);
    status.listening = wide ? "network" : "loopback";
    return structuredClone(status);
  };
  const words = ["maple", "river", "quiet", "orbit", "candle", "lantern", "harbor", "violet"];
  return {
    status: async () => structuredClone(status),
    async setEnabled(enabled) {
      if (enabled && !status.passwordSet) {
        throw new ApiRequestError(400, "password_required", "Set a password first.");
      }
      return set({ enabled });
    },
    setLoopbackOnly: async (loopbackOnly) => set({ loopbackOnly }),
    async setPassword(input) {
      const generated =
        "generate" in input
          ? Array.from({ length: 5 }, () => words[Math.floor(Math.random() * words.length)]).join(
              "-",
            )
          : null;
      const problem = generated ? null : passwordProblem((input as { password: string }).password);
      if (problem) throw new ApiRequestError(400, "weak_password", problem);
      const next = set({ passwordSet: true, passwordSetAt: new Date().toISOString(), devices: [] });
      return { status: next, generated };
    },
    signOutDevice: async (id) => set({ devices: status.devices.filter((d) => d.id !== id) }),
    signOutAll: async () => set({ devices: [] }),
  };
}

/** The mock is always this computer, signed in. */
export function mockAuthApi(): AuthApi {
  return {
    status: async () => ({ remote: false, signedIn: true, networkEnabled: false }),
    signIn: async () => {},
    signOut: async () => {},
  };
}
