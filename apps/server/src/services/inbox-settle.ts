import type {
  FactoryItem,
  FactoryItemStage,
  GitHubPrRef,
  InboxItem,
  InboxSettlement,
  RawEventEnvelope,
  Session,
} from "@codeden/contracts";
import { FACTORY_HANDLES_FAILURE } from "../events/reducer/items";
import type { EventStore } from "../events/store";
import { errorMessage } from "./errors";
import { isFactorySession } from "./factory/starter";
import type { InboxService } from "./inbox-service";
import type { SessionRepo } from "./sessions/repo";

/**
 * Failed runs settle on their own (§11.1): a `run_failed` item stays waiting on the user only
 * while its work is stuck. It resolves, with a short note, once the work moved on: the session
 * ran again, another session of the same work succeeded, a pull request of the work merged (or
 * the session's own was closed), the factory item of the work is done or rejected, or the same
 * work failed again the same way in a later session (whose item is the one that counts). A
 * factory session's failure is the factory's to handle and never waits on the user.
 *
 * The pass runs at startup, which also settles items left from before this rule, and shortly
 * after sessions, turns, factory items or failed runs change.
 */

export interface RunFailedSettlerDeps {
  store: EventStore;
  repo: SessionRepo;
  inbox: InboxService;
  /** The project's factory items, newest first. */
  factoryItems: (projectId: string) => FactoryItem[];
  /** How long after a change the pass runs, so a burst of events runs it once (default 1 s). */
  debounceMs?: number;
  log?: (message: string) => void;
}

/** What is known around one open `run_failed` item. */
export interface SettleView {
  session: Session | undefined;
  /** The item records a factory session's failure (`notify: "factory"`), which the factory handles. */
  factoryFailure: boolean;
  /** The session finished a turn after the failure. */
  ranAgain: boolean;
  /**
   * Another session doing the same work (same work key, role and purpose: a re-run, a hand-off,
   * a fork) that finished a turn since the failure. A reviewer or triage session on the same
   * issue doesn't count.
   */
  succeededElsewhere: Session | undefined;
  /** A pull request of the work that merged, or the session's own that was closed. */
  prDone: GitHubPrRef | null;
  /** The factory item of the same work, if any (newest). */
  factoryItem: FactoryItem | undefined;
  /** A later session of the same work failed again the same way (its item is still open). */
  failedAgainLater: boolean;
}

const DONE: ReadonlySet<FactoryItemStage> = new Set(["watching", "merged", "reverted"]);
const DROPPED: ReadonlySet<FactoryItemStage> = new Set(["rejected", "ignored"]);

/** Why the item settles now, or null while it still waits on the user. Pure. */
export function settlement(v: SettleView): InboxSettlement | null {
  const by = "codeden" as const;
  if (v.ranAgain) return { by, note: "The session ran again" };
  if (v.prDone) return { by, note: `PR #${v.prDone.number} ${v.prDone.state}` };
  if (v.factoryItem && DONE.has(v.factoryItem.stage)) {
    return { by, note: "The factory finished this work" };
  }
  if (v.factoryItem && DROPPED.has(v.factoryItem.stage)) {
    return { by, note: "The factory dropped this work" };
  }
  if (v.succeededElsewhere) {
    const name = v.succeededElsewhere.title ?? v.succeededElsewhere.purpose;
    return { by, note: `Another session of the same work succeeded: ${name}` };
  }
  if (v.failedAgainLater) {
    return { by, note: "The same work failed again the same way later: see the newer item" };
  }
  if (v.factoryFailure && v.session && isFactorySession(v.session)) {
    return { by: "factory", note: FACTORY_HANDLES_FAILURE };
  }
  return null;
}

/**
 * The factory's own inbox items (stuck work, a paused loop, a regression, an escalation, the
 * digest): the factory raises and resolves them, and some need a person, so they never settle
 * here.
 */
const FACTORY_ITEM_PREFIX = "inbox:factory-";

/** Events after which an open failed run may have settled. */
const RELEVANT = new Set([
  "session.updated",
  "agent.turn.completed",
  "factory.item.updated",
  "inbox.created",
]);

export class RunFailedSettler {
  private unsubscribe: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: RunFailedSettlerDeps) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    // Items left from before a restart (or before failed runs settled on their own).
    setImmediate(() => {
      if (!this.stopped) this.sweepSafely();
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Settle every open `run_failed` item whose work moved on; returns the settled items. */
  sweep(): InboxItem[] {
    const open = this.deps.inbox
      .list()
      .filter(
        (i) => i.kind === "run_failed" && i.sessionId && !i.id.startsWith(FACTORY_ITEM_PREFIX),
      );
    if (open.length === 0) return [];
    const sessions = new Map<string, Session | undefined>();
    const sessionOf = (id: string) => {
      if (!sessions.has(id)) sessions.set(id, this.deps.repo.find(id)?.session);
      return sessions.get(id);
    };
    const factoryItems = new Map<string, FactoryItem[]>();
    const factoryItemsOf = (projectId: string) => {
      let list = factoryItems.get(projectId);
      if (!list) {
        list = this.deps.factoryItems(projectId);
        factoryItems.set(projectId, list);
      }
      return list;
    };
    const settled: InboxItem[] = [];
    for (const item of open) {
      const session = sessionOf(item.sessionId as string);
      const workOf = (s: Session | undefined) =>
        s?.projectId && s.workKey ? `${s.projectId}\n${s.workKey}` : null;
      const work = workOf(session);
      const view: SettleView = {
        session,
        factoryFailure: item.notify === "factory",
        ranAgain: session ? this.finishedTurnSince(session, item.updatedAt) : false,
        succeededElsewhere: undefined,
        prDone: null,
        factoryItem: undefined,
        failedAgainLater: open.some(
          (other) =>
            other !== item &&
            other.sessionId !== item.sessionId &&
            other.body === item.body &&
            other.createdAt > item.createdAt &&
            work !== null &&
            workOf(sessionOf(other.sessionId as string)) === work,
        ),
      };
      if (session?.projectId && session.workKey) {
        const siblings = this.deps.repo
          .list({ projectId: session.projectId, workKey: session.workKey })
          .filter((s) => s.id !== session.id);
        view.succeededElsewhere = siblings.find(
          (s) =>
            s.role === session.role &&
            s.purpose === session.purpose &&
            this.finishedTurnSince(s, item.createdAt),
        );
        view.prDone = prDone(item, session, siblings);
        view.factoryItem = factoryItemsOf(session.projectId).find(
          (f) => f.workKey === session.workKey,
        );
      } else if (session) {
        view.prDone = prDone(item, session, []);
      }
      const why = settlement(view);
      if (why) settled.push(this.deps.inbox.settle(item, why));
    }
    if (settled.length > 0) {
      this.deps.log?.(`inbox: settled ${settled.length} failed run(s) whose work moved on`);
    }
    return settled;
  }

  /** Whether the session's last root turn completed after `since`. */
  private finishedTurnSince(session: Session, since: string): boolean {
    const last = this.deps.repo.rootTurnIds(session).at(-1);
    const turn = last ? this.deps.repo.turn(session.id, last) : null;
    return turn?.status === "completed" && turn.completedAt !== null && turn.completedAt > since;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    if (this.stopped || this.timer) return;
    const relevant = events.some(
      (e) =>
        RELEVANT.has(e.type) &&
        (e.type !== "inbox.created" ||
          (e.payload as { item?: InboxItem }).item?.kind === "run_failed"),
    );
    if (!relevant) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.sweepSafely();
    }, this.deps.debounceMs ?? 1000);
    this.timer.unref?.();
  }

  private sweepSafely(): void {
    try {
      this.sweep();
    } catch (error) {
      this.deps.log?.(`inbox: settling failed runs: ${errorMessage(error)}`);
    }
  }
}

/** A pull request of the work that merged, or the session's own (or the item's) that closed. */
function prDone(item: InboxItem, session: Session, siblings: Session[]): GitHubPrRef | null {
  const own = session.pr ?? item.pr;
  if (own && (own.state === "merged" || own.state === "closed")) return own;
  return siblings.map((s) => s.pr).find((pr) => pr?.state === "merged") ?? null;
}
