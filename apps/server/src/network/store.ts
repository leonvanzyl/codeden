import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  passwordProblem,
  REMOTE_SESSION_DAYS,
  RemoteAccessFile,
  type RemoteSessionRecord,
} from "@codeden/contracts";
import { writeJsonFile } from "../json-file";
import { type FileReset, loadUserJsonFile } from "../user-json-file";
import { hashPassword, verifyPassword } from "./password";

/** Owner-only: the file holds the password's hash and the session token hashes. */
const FILE_MODE = 0o600;
/** Prefix of remote session tokens, so they are recognisable in a cookie jar. */
const TOKEN_PREFIX = "cds_";
const SESSION_MS = REMOTE_SESSION_DAYS * 24 * 60 * 60_000;
/** `lastSeenAt` is written to disk at most this often per session. */
const SEEN_WRITE_MS = 60_000;
const LABEL_MAX = 200;

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A password the rules refuse, with the reason in plain words. */
export class PasswordRuleError extends Error {
  readonly code = "weak_password";
}

/**
 * `<home>/remote-access.json` (§15.1): the network switch, the password's scrypt hash and the
 * remote sessions (hashes of their tokens only). Shared by the server and the `codeden
 * password` / `codeden network` commands when no server is running.
 */
export class RemoteAccessStore {
  private data: RemoteAccessFile;
  private readonly seenWritten = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    /** Called when a damaged file was kept as a copy and reset (the server and CLI report it). */
    private readonly onReset?: (reset: FileReset) => void,
  ) {
    this.data = this.load();
  }

  get enabled(): boolean {
    return this.data.enabled;
  }

  get passwordSet(): boolean {
    return this.data.password !== null;
  }

  get passwordSetAt(): string | null {
    return this.data.password?.setAt ?? null;
  }

  /** Re-read the file (the CLI may have changed it while the server was stopped). */
  reload(): void {
    this.data = this.load();
  }

  /**
   * Set the password after checking the rules (throws `PasswordRuleError`), and sign out every
   * remote device.
   */
  async setPassword(password: string): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new PasswordRuleError(problem);
    const hash = await hashPassword(password);
    this.data = {
      ...this.data,
      password: { hash, setAt: new Date(this.now()).toISOString() },
      sessions: [],
    };
    this.save();
  }

  async checkPassword(password: string): Promise<boolean> {
    const stored = this.data.password?.hash;
    return stored ? verifyPassword(password, stored) : false;
  }

  /** Turn network access on or off. Turning it on without a password throws. */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.passwordSet) {
      throw new Error("Set a network access password before turning network access on.");
    }
    this.data = { ...this.data, enabled };
    this.save();
  }

  /** Start a 90-day session for a device; returns the token for its cookie (stored hashed). */
  createSession(device: { label: string; address: string | null }): {
    token: string;
    session: RemoteSessionRecord;
  } {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const session: RemoteSessionRecord = {
      id: randomUUID(),
      tokenHash: sha256(token),
      label: device.label.slice(0, LABEL_MAX) || "Unknown device",
      address: device.address,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_MS).toISOString(),
    };
    this.data = { ...this.data, sessions: [...this.liveSessions(), session] };
    this.save();
    return { token, session };
  }

  /** The live session for a cookie token (and note that it was seen), else undefined. */
  verifySession(token: string | undefined): RemoteSessionRecord | undefined {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    const hash = sha256(token);
    const now = this.now();
    const session = this.data.sessions.find((s) => s.tokenHash === hash);
    if (!session || Date.parse(session.expiresAt) <= now) return undefined;
    session.lastSeenAt = new Date(now).toISOString();
    const written = this.seenWritten.get(session.id) ?? 0;
    if (now - written >= SEEN_WRITE_MS) {
      this.seenWritten.set(session.id, now);
      this.save();
    }
    return session;
  }

  /** Unexpired sessions, oldest first. */
  liveSessions(): RemoteSessionRecord[] {
    const now = this.now();
    return this.data.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  }

  /** Sign out one device; false when there was no such session. */
  revoke(id: string): boolean {
    const before = this.data.sessions.length;
    this.data = { ...this.data, sessions: this.data.sessions.filter((s) => s.id !== id) };
    if (this.data.sessions.length === before) return false;
    this.save();
    return true;
  }

  /** Sign out every device. */
  revokeAll(): void {
    this.data = { ...this.data, sessions: [] };
    this.save();
  }

  private load(): RemoteAccessFile {
    // A damaged file fails closed: network access off, no password, nobody signed in. It is
    // kept as a copy (owner-only, like the file) first, so the next save never overwrites it.
    const { value, reset } = loadUserJsonFile(this.file, RemoteAccessFile, {
      mode: FILE_MODE,
      now: this.now,
    });
    if (reset) this.onReset?.(reset);
    return value;
  }

  private save(): void {
    writeJsonFile(this.file, this.data, FILE_MODE);
  }
}
