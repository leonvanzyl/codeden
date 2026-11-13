import { randomUUID } from "node:crypto";
import type { MessageSender, Session, UserInput } from "@codeden/contracts";
import type { SessionRepo } from "../sessions/repo";
import type { NoticeStore } from "./notices";
import { type WakeResult, WakeScheduler, type WakeSchedulerOptions } from "./wake-scheduler";

/** Who wants a message to go from the orchestrator to a PM. */
export interface MessageOrigin {
  /** `ui` when the user called the tool through an API handler, `mcp` when an agent did. */
  caller: "mcp" | "ui";
  /** The calling session (the orchestrator), when known. */
  sessionId: string | null;
}

/** An orchestrator message the guard held back, and when it lets it go (epoch ms). */
export interface HeldMessage {
  status: "held";
  until: number;
}

/**
 * Where the guard keeps whether each role session's latest turn carries the user's request,
 * so a turn that outlives a server restart (the runner keeps it going) keeps its origin.
 */
export interface TurnOrigins {
  /** The recorded origin; `undefined` when none was ever recorded. */
  load(sessionId: string): boolean | undefined;
  save(sessionId: string, fromUser: boolean): void;
}

/**
 * Turn origins kept with each role session's start metadata (`turnFromUser`). A session
 * without start metadata records nothing; an origin never recorded counts as not the user's.
 */
export function turnOriginsIn(repo: Pick<SessionRepo, "find" | "setStartMeta">): TurnOrigins {
  return {
    load: (sessionId) => repo.find(sessionId)?.startMeta?.turnFromUser,
    save: (sessionId, fromUser) => {
      const stored = repo.find(sessionId)?.startMeta;
      if (!stored) return;
      repo.setStartMeta(sessionId, (meta) => ({ ...(meta ?? stored), turnFromUser: fromUser }));
    },
  };
}

/** What the delivery of a role session's turn reports back (`LoopGuard.beginTurn`). */
export interface TurnDelivery {
  /** The runner took the turn. */
  accepted: () => void;
  /**
   * It failed. `mayHaveStarted`: the outcome is unknown (a timeout or lost connection, after
   * which the runner may be running the turn anyway); otherwise the runner refused it.
   */
  failed: (mayHaveStarted: boolean) => void;
}

export interface LoopGuardDeps {
  /** The notice-wake scheduler: a PM and its sessions, PM messages to the orchestrator. */
  wakes: WakeScheduler;
  notices: Pick<NoticeStore, "create" | "undelivered">;
  /** Wake the PM of a project, delivering its undelivered notices. */
  wakePm: (projectId: string) => Promise<WakeResult>;
  /** Persisted turn origins. Without them the guard remembers origins until it is disposed. */
  turnOrigins?: TurnOrigins;
  options?: WakeSchedulerOptions;
  log?: (message: string) => void;
}

const pmKey = (projectId: string | null) => `pm:${projectId ?? ""}`;

/**
 * Loop protection between role sessions (§8.2). A loop is agents messaging each other with no
 * person in between: the orchestrator and a PM, or a PM and its sessions. So the guard:
 *
 * - counts each conversation on its own: the orchestrator's messages to a PM here, notice
 *   wakes (a PM's sessions reporting, PM messages to the orchestrator) in the `wakes`
 *   scheduler. A PM busy with its sessions' reports never blocks the orchestrator, or the
 *   other way round;
 * - never holds back what the user asked for: a message sent through the UI, or by the
 *   orchestrator in a turn the user started, always goes straight through, and like any
 *   message the user writes to a role session it clears that session's counts;
 * - holds back, never refuses, the rest: past the limit an orchestrator message is stored as
 *   an `orchestrator.message` notice and reaches the PM with its next wake, at the latest when
 *   the window allows another message. Nobody has to wait and retry.
 */
export class LoopGuard {
  /** The orchestrator's messages to each PM (`pm:<projectId>`) from turns it started itself. */
  readonly relays: WakeScheduler;
  /** Whether each role session's latest turn carries the user's request (see `turnStarted`). */
  private readonly userTurns = new Map<string, boolean>();

  constructor(private readonly deps: LoopGuardDeps) {
    this.relays = new WakeScheduler((key) => this.deliverHeld(key.slice("pm:".length)), {
      ...deps.options,
      onSuppressed: (key, until) =>
        deps.log?.(
          `orchestration: loop guard holds the orchestrator's messages to ${key} until ${new Date(until).toISOString()}`,
        ),
      onGaveUp: (key) =>
        deps.log?.(`orchestration: ${key} stayed busy; held messages wait for its next wake`),
    });
  }

  /**
   * A delivery of `input` from `from` to a role session begins. The turn it starts carries the
   * user's request when the user wrote it, or when the orchestrator passed it on from a turn the
   * user started (`relayedForUser`). Authority follows the delivery the runner accepted:
   *
   * - while it is in flight the session has none (saved too, before anything is sent);
   * - `accepted` records the turn's origin (saved, so it survives a server restart) and, for
   *   the user's own input, clears the session's counts;
   * - `failed` after a definite refusal puts back the origin of the turn the last accepted
   *   delivery started, so a rejected message never lends its origin to the turn that is
   *   running. When the runner may have started the turn anyway (a timeout or lost
   *   connection), the session keeps no authority: what runs may be this automatic turn, and
   *   it stays so until a later delivery is accepted.
   *
   * The session service delivers one message per session at a time, so nothing else changes
   * the origin between the two.
   */
  beginTurn(
    session: Session,
    from: MessageSender,
    input?: Pick<UserInput, "relayedForUser">,
  ): TurnDelivery {
    if (session.role === "agent") return { accepted: () => {}, failed: () => {} };
    const previous = this.originOf(session.id);
    const fromUser = from === "user" || (from === "orchestrator" && input?.relayedForUser === true);
    this.record(session.id, false);
    return {
      accepted: () => {
        this.record(session.id, fromUser);
        if (from !== "user") return;
        this.clear(session.role === "pm" ? pmKey(session.projectId) : "orchestrator");
      },
      failed: (mayHaveStarted) => this.record(session.id, mayHaveStarted ? false : previous),
    };
  }

  /** A role session's turn started with input from `from` (`beginTurn`, then accepted). */
  turnStarted(session: Session, from: MessageSender, input?: Pick<UserInput, "relayedForUser">) {
    this.beginTurn(session, from, input).accepted();
  }

  /**
   * Whether a request carries the user's own words: it came through the UI, or from a role
   * session's turn that the user's message started (directly, or relayed by the orchestrator).
   * Turns started by automations, notices, wake-ups and other agents never do, and neither
   * does a turn whose origin was never recorded or whose input is still being delivered.
   */
  humanLed(origin: MessageOrigin): boolean {
    if (origin.caller === "ui") return true;
    return origin.sessionId !== null && this.originOf(origin.sessionId);
  }

  /**
   * Whether an orchestrator message may go to the PM of `projectId` now. The user's requests
   * always may (and clear the PM's counts); others count against the limit, and wait behind
   * messages already held so none overtakes another. When this is false, `hold` the message.
   */
  mayDeliver(projectId: string, origin: MessageOrigin): boolean {
    const key = pmKey(projectId);
    if (this.humanLed(origin)) {
      this.clear(key);
      return true;
    }
    if (!this.relays.allowed(key) || this.relays.isPending(key)) return false;
    this.relays.recordWake(key);
    return true;
  }

  /**
   * Keep an orchestrator message for the PM of `projectId` and deliver it with the PM's next
   * wake. Returns when the guard lets it go (any earlier wake of the PM takes it along, and a
   * PM in the middle of a turn gets it once the turn ends).
   */
  hold(projectId: string, fromSessionId: string | null, text: string): number {
    this.deps.notices.create({
      id: `orchestrator.message:${randomUUID()}`,
      type: "orchestrator.message",
      projectId,
      target: "pm",
      sessionId: fromSessionId,
      title: "Message from the orchestrator",
      data: { fromSessionId, text },
    });
    const key = pmKey(projectId);
    this.relays.request(key);
    return this.relays.freeAt(key);
  }

  dispose(): void {
    this.relays.dispose();
  }

  /** Wake the PM for its held messages; another wake may have delivered them already. */
  private async deliverHeld(projectId: string): Promise<WakeResult> {
    const held = this.deps.notices
      .undelivered("pm", projectId)
      .some((n) => n.type === "orchestrator.message");
    return held ? this.deps.wakePm(projectId) : "empty";
  }

  /** A role session's turn origin; a turn started before this server did has its saved one. */
  private originOf(sessionId: string): boolean {
    let fromUser = this.userTurns.get(sessionId);
    if (fromUser === undefined) {
      fromUser = this.deps.turnOrigins?.load(sessionId) === true;
      this.userTurns.set(sessionId, fromUser);
    }
    return fromUser;
  }

  /** Save, then remember, a role session's turn origin (a failed save throws, unchanged). */
  private record(sessionId: string, fromUser: boolean): void {
    if (this.userTurns.get(sessionId) === fromUser) return;
    this.deps.turnOrigins?.save(sessionId, fromUser);
    this.userTurns.set(sessionId, fromUser);
  }

  private clear(key: string): void {
    this.deps.wakes.reset(key);
    this.relays.reset(key);
  }
}
