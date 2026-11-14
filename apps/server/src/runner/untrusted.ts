import type { RunnerCommand, RunnerStream } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";

/**
 * What an untrusted runner (any but the home runner) may send besides its sessions' events
 * (`untrustedEventRefusal` in `events/ingest.ts`): terminal output and exits only for ptys the
 * server opened or attached on it, and browser streams only for sessions routed to it.
 *
 * The server chooses pty ids and sends them in `pty.open`, so the ptys a runner may speak for
 * are the ones the server sent it. They are kept in memory: after a server restart, a sandbox
 * runner's exit events for ptys from before are dropped, which loses nothing (no view is
 * attached any more, and `pty.attach` reports the exit).
 */
export class UntrustedRunnerGuard {
  private readonly ptys = new Set<string>();

  constructor(private readonly db: Db) {}

  /** Note a command the server is about to send this runner. */
  sending(command: RunnerCommand): void {
    if (command.name === "pty.open" || command.name === "pty.attach") this.ptys.add(command.ptyId);
  }

  ownsPty(ptyId: string): boolean {
    return this.ptys.has(ptyId);
  }

  /** The pty's exit was stored: it has nothing more to send. */
  ptyExited(ptyId: string): void {
    this.ptys.delete(ptyId);
  }

  /** Whether a stream from this runner (journal id `runnerId`) may reach the UI. */
  allowsStream(stream: RunnerStream, runnerId: string | undefined): boolean {
    if (stream.kind === "pty.output") return this.ptys.has(stream.ptyId);
    if (!runnerId) return false;
    const row = this.db
      .select({ runnerId: sessions.runnerId })
      .from(sessions)
      .where(eq(sessions.id, stream.sessionId))
      .get();
    return row?.runnerId === runnerId;
  }
}
