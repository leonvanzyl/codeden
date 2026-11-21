import { z } from "zod";
import { Timestamp } from "./common";

/**
 * Network access (§15.1): an opt-in way to open CodeDen from a phone or tablet on the same
 * network, or over the user's own VPN. Off by default; turning it on needs a password. The
 * runner, `/mcp` and network management stay loopback-only whatever this says.
 */

/** Shortest accepted network-access password. */
export const PASSWORD_MIN_LENGTH = 15;
/** Longest accepted password (keeps hashing cheap and bounded). */
export const PASSWORD_MAX_LENGTH = 256;
/** How long a remote device stays signed in. */
export const REMOTE_SESSION_DAYS = 90;

/** The password rules in plain words, shown next to the password field. */
export const PASSWORD_RULE_TEXT =
  "Use at least 15 characters. A short sentence or a few random words works well. Very common passwords, repeated characters and simple sequences such as abcdef… or 12345… are refused.";

/** Base words of very common passwords; a password made of one of these plus digits is refused. */
const COMMON_WORDS = new Set([
  "password",
  "passw0rd",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "iloveyou",
  "qwerty",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "sunshine",
  "princess",
  "superman",
  "batman",
  "trustno",
  "master",
  "shadow",
  "michael",
  "jennifer",
  "computer",
  "secret",
  "changeme",
  "codeden",
  "default",
  "login",
  "hello",
  "abc",
  "test",
  "guest",
  "root",
  "starwars",
  "whatever",
  "freedom",
  "mustang",
  "pokemon",
  "charlie",
  "correcthorsebatterystaple",
]);

/** Character runs a "sequence" password walks along (alphabet, digits, keyboard rows). */
const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiopasdfghjklzxcvbnm",
  "qwertzuiopasdfghjklyxcvbnm",
  "azertyuiopqsdfghjklmwxcvbn",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
  "qazwsxedcrfvtgbyhnujmikolp",
  "1234567890qwertyuiopasdfghjklzxcvbnm",
];

/** True when `text` is one short unit repeated (`abcabcabc`, `passwordpassword`). */
function isRepeatedUnit(text: string): boolean {
  for (let size = 1; size <= text.length / 2; size++) {
    if (text.length % size !== 0) continue;
    if (text.slice(0, size).repeat(text.length / size) === text) return true;
  }
  return false;
}

/** True when `text` walks along one of the known sequences, forwards or backwards (wrapping). */
function isSequence(text: string): boolean {
  return SEQUENCES.some((seq) => {
    const looped = seq.repeat(Math.ceil(text.length / seq.length) + 2);
    const reversed = [...looped].reverse().join("");
    return looped.includes(text) || reversed.includes(text);
  });
}

/**
 * Why `password` can't be used for network access, in plain words, or null when it is fine.
 * Shared by the server (which enforces it) and the UI (which explains it as you type).
 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters (this one has ${password.length}).`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (new Set(compact).size < 5 || isRepeatedUnit(compact)) {
    return "That repeats the same few characters. Try a few random words instead.";
  }
  if (isSequence(compact)) {
    return "That is a simple sequence. Try a few random words instead.";
  }
  const letters = lower.replace(/[^a-z]/g, "");
  const words = lower.split(/[^a-z]+/).filter(Boolean);
  const onlyCommon =
    letters.length > 0 &&
    (COMMON_WORDS.has(letters) ||
      isRepeatedUnitOf(letters, COMMON_WORDS) ||
      (words.length > 0 && words.every((w) => COMMON_WORDS.has(w))));
  if (onlyCommon) {
    return "That is too close to a very common password. Try a few random words instead.";
  }
  return null;
}

function isRepeatedUnitOf(text: string, units: ReadonlySet<string>): boolean {
  for (const unit of units) {
    if (text.length % unit.length === 0 && unit.repeat(text.length / unit.length) === text) {
      return true;
    }
  }
  return false;
}

/** Most trusted origins a home can list. */
export const TRUSTED_ORIGINS_MAX = 10;

const TRUSTED_ORIGIN_RE =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}))?$/;

/**
 * Check a trusted origin (§15.1): the HTTPS address of a reverse proxy on this machine, such as
 * Tailscale Serve. Returns the normalized form (lowercase, `:443` dropped)
 * or the reason it is refused. Only `https://<dns name>[:port]` is accepted: no path, query,
 * fragment or credentials, no IP literals (a proxy certificate names a host), no loopback
 * names (those are already local), no port 0 or above 65535.
 */
export function parseTrustedOrigin(
  input: string,
): { ok: true; origin: string } | { ok: false; problem: string } {
  const text = input.trim().toLowerCase();
  if (text.startsWith("http://")) return { ok: false, problem: "Use an https:// address." };
  const match = TRUSTED_ORIGIN_RE.exec(text);
  if (!match || text.length > 260) {
    return {
      ok: false,
      problem: "Use https://<host name>[:port] only: no path, query, credentials or IP address.",
    };
  }
  const host = match[1] as string;
  const labels = host.split(".");
  if (/^\d+$/.test(labels.at(-1) as string)) {
    return { ok: false, problem: "Use a host name, not an IP address." };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, problem: "That is this computer; it needs no trusted origin." };
  }
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) return { ok: false, problem: "That port is not valid." };
  return { ok: true, origin: `https://${host}${port === 443 ? "" : `:${port}`}` };
}

/** A trusted origin in its normalized form (see `parseTrustedOrigin`). */
export const TrustedOrigin = z.string().transform((value, ctx) => {
  const parsed = parseTrustedOrigin(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.problem });
    return z.NEVER;
  }
  return parsed.origin;
});

/**
 * Recovery for a hand-edited `remote-access.json`: keep the entries that pass
 * `parseTrustedOrigin` (normalized, without repeats, at most `TRUSTED_ORIGINS_MAX`) and drop
 * the rest, so one bad entry never resets the password and sessions beside it.
 */
function keepValidOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const entry of value) {
    const parsed = typeof entry === "string" ? parseTrustedOrigin(entry) : undefined;
    if (parsed?.ok && !kept.includes(parsed.origin)) kept.push(parsed.origin);
  }
  return kept.slice(0, TRUSTED_ORIGINS_MAX);
}

/** Which kind of address the server answers on. `vpn` covers Tailscale's `100.64.0.0/10`. */
export const NetworkAddressKind = z.enum(["local", "lan", "vpn"]);
export type NetworkAddressKind = z.infer<typeof NetworkAddressKind>;

/** One address CodeDen can be opened on, with the URL a phone would scan. */
export const NetworkAddress = z.object({
  kind: NetworkAddressKind,
  /** Human label, e.g. "This computer", "Wi-Fi (192.168.1.20)", "Tailscale". */
  label: z.string(),
  /** The interface the address belongs to (`Wi-Fi`, `eth0`, `tailscale0`), or null for localhost. */
  interfaceName: z.string().nullable(),
  /** The bare host: `localhost` or an IPv4 address. */
  host: z.string(),
  /** `http://<host>:<port>`. */
  url: z.string(),
});
export type NetworkAddress = z.infer<typeof NetworkAddress>;

/** A signed-in remote device, as listed in Settings › Network access (never the token). */
export const RemoteDevice = z.object({
  id: z.string(),
  /** The browser's user agent when it signed in (trimmed). */
  label: z.string(),
  /** The address it signed in from. */
  address: z.string().nullable(),
  /** `address` was reported by a trusted proxy (`X-Forwarded-For`), not seen on the socket. */
  addressViaProxy: z.boolean().default(false),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
  /** The device making this request. */
  current: z.boolean(),
});
export type RemoteDevice = z.infer<typeof RemoteDevice>;

/**
 * `GET /api/network`: whether network access is on, where CodeDen answers, and who is signed
 * in. `remote` tells the caller whether it is itself a remote device (management is
 * loopback-only, so the UI shows the controls read-only there).
 */
export const NetworkStatus = z.object({
  enabled: z.boolean(),
  passwordSet: z.boolean(),
  passwordSetAt: Timestamp.nullable(),
  /** Where the HTTP listener is bound right now. */
  listening: z.enum(["loopback", "network"]),
  /** Keep the listener on 127.0.0.1 while access is on, so a proxy on this machine is the only way in. */
  loopbackOnly: z.boolean().default(false),
  /** HTTPS addresses of a trusted reverse proxy on this machine (e.g. Tailscale Serve). */
  trustedOrigins: z.array(TrustedOrigin).max(TRUSTED_ORIGINS_MAX).default([]),
  port: z.int().nonnegative(),
  /** Addresses CodeDen answers on: localhost always, LAN and VPN addresses when enabled. */
  addresses: z.array(NetworkAddress),
  /** Addresses it would answer on once enabled (for the off state's preview). */
  candidates: z.array(NetworkAddress),
  devices: z.array(RemoteDevice),
  remote: z.boolean(),
});
export type NetworkStatus = z.infer<typeof NetworkStatus>;

/**
 * `POST /api/network/password` (loopback only): set a password, or let the server generate a
 * passphrase. Either way every remote device is signed out.
 */
export const SetNetworkPasswordRequest = z.union([
  z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }),
  z.object({ generate: z.literal(true) }),
]);
export type SetNetworkPasswordRequest = z.infer<typeof SetNetworkPasswordRequest>;

/** Response to setting the password: the generated passphrase is returned once, never again. */
export const SetNetworkPasswordResponse = z.object({
  status: NetworkStatus,
  generated: z.string().nullable(),
});
export type SetNetworkPasswordResponse = z.infer<typeof SetNetworkPasswordResponse>;

/**
 * `PUT /api/network` (loopback only): turn network access on or off, and/or keep the listener
 * on 127.0.0.1 (`loopbackOnly`) so only a trusted proxy on this machine reaches it.
 */
export const SetNetworkAccessRequest = z
  .object({ enabled: z.boolean().optional(), loopbackOnly: z.boolean().optional() })
  .refine((v) => v.enabled !== undefined || v.loopbackOnly !== undefined, {
    message: "Say what to change.",
  });
export type SetNetworkAccessRequest = z.infer<typeof SetNetworkAccessRequest>;

/** `POST /api/network/origins` (loopback only): trust the HTTPS address of a proxy on this machine. */
export const AddTrustedOriginRequest = z.object({ url: TrustedOrigin });
export type AddTrustedOriginRequest = z.infer<typeof AddTrustedOriginRequest>;

/** `POST /api/auth/sign-in` from a remote device. */
export const SignInRequest = z.object({ password: z.string().max(PASSWORD_MAX_LENGTH) });
export type SignInRequest = z.infer<typeof SignInRequest>;

/** `GET /api/auth/status`: what the sign-in page needs to know (public). */
export const AuthStatus = z.object({
  /** The caller is not on this machine. */
  remote: z.boolean(),
  /** The caller has a valid session (remote) or install-token cookie (local). */
  signedIn: z.boolean(),
  networkEnabled: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** A failed sign-in: `retryAfterSec` is set while the address must wait or is locked out. */
export const SignInError = z.object({
  error: z.object({
    code: z.enum(["invalid_password", "rate_limited", "locked_out", "network_off"]),
    message: z.string(),
    retryAfterSec: z.int().nonnegative().nullable(),
  }),
});
export type SignInError = z.infer<typeof SignInError>;

/** A stored remote session: only the SHA-256 hash of its token is kept. */
export const RemoteSessionRecord = z.object({
  id: z.string(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  label: z.string(),
  address: z.string().nullable(),
  addressViaProxy: z.boolean().default(false),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
});
export type RemoteSessionRecord = z.infer<typeof RemoteSessionRecord>;

/**
 * `<home>/remote-access.json` (mode 0600): the network switch, the password hash (scrypt,
 * salted; never the password) and the remote sessions. Kept out of `settings.json` so the
 * settings API can't switch network access on without the checks.
 */
export const RemoteAccessFile = z.object({
  schemaVersion: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  password: z
    .object({
      /** `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`. */
      hash: z.string().startsWith("scrypt$"),
      setAt: Timestamp,
    })
    .nullable()
    .default(null),
  sessions: z.array(RemoteSessionRecord).default([]),
  /** Keep the listener on 127.0.0.1 while `enabled` (a proxy on this machine fronts it). */
  loopbackOnly: z.boolean().default(false),
  /**
   * `https://host[:port]` origins of a trusted proxy on this machine, at most 10. Entries that
   * break the rules (hand edits) are dropped when the file is read, never trusted.
   */
  trustedOrigins: z.preprocess(keepValidOrigins, z.array(TrustedOrigin).max(TRUSTED_ORIGINS_MAX)),
});
export type RemoteAccessFile = z.infer<typeof RemoteAccessFile>;
