import {
  CODEDEN_VERSION,
  type RawEventEnvelope,
  UI_PROTOCOL_VERSION,
  UiClientMessage,
  type UiServerMessage,
  type UpdateStatus,
} from "@codeden/contracts";
import type { WSContext, WSEvents } from "hono/ws";
import type { Db } from "../db/client";
import type { EventStore } from "../events/store";
import type { RunnersStatus } from "../runner/hub";
import { type ArtifactLookup, clientEvent } from "../services/sessions/client-items";
import { coalesceEvents } from "./coalesce";
import { collectDirty, type Dirty, emptyDirty, isDirty, loadTranscript } from "./transcript";

/** Clients further behind than this must reload the snapshot instead of replaying. */
const MAX_CATCH_UP = 50_000;
/** A watch replaying more events than this reloads the transcript over HTTP instead. */
const MAX_WATCH_REPLAY = 20_000;
/** A client with this many undelivered events is told to resync (it cannot keep up). */
const MAX_PENDING = 10_000;
const BATCH = 500;

interface Watch {
  threadIds: Set<string> | undefined;
  dirty: Dirty;
}

interface Client {
  ws: WSContext;
  /** Highest seq delivered on the global stream; `undefined` until subscribed. */
  lastSent: number | undefined;
  sessionIds: Set<string> | undefined;
  agentEvents: boolean;
  pending: RawEventEnvelope[];
  watches: Map<string, Watch>;
  timer: NodeJS.Timeout | undefined;
}

export interface WsHubOptions {
  /** Live updates are batched for this long (default 40ms). */
  flushMs?: number;
  /** The update status sent to each client on connect (§16). */
  updateStatus?: () => UpdateStatus;
  /**
   * Maps image paths in user messages back to their artifacts (`clientItemRecord`). Without
   * it, such paths are cut down to their file name.
   */
  artifacts?: ArtifactLookup;
}

const noArtifacts: ArtifactLookup = { artifactForPath: () => undefined };

/**
 * UI realtime hub (§6). Global stream: snapshot seq -> `subscribe { fromSeq }` -> catch-up ->
 * live `events`, batched every ~40ms with text deltas merged. Transcripts: `watch_session`
 * sends the latest state of changed threads, turns and items, then live `transcript` updates.
 * Catch-up runs synchronously and appends are synchronous, so nothing slips in between.
 */
export class WsHub {
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: () => void;
  private readonly flushMs: number;
  private readonly artifacts: ArtifactLookup;

  constructor(
    private readonly store: EventStore,
    private readonly db: Db,
    private readonly runnerStatus: () => RunnersStatus,
    private readonly opts: WsHubOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 40;
    this.artifacts = opts.artifacts ?? noArtifacts;
    this.unsubscribe = store.subscribe((events) => this.onEvents(events));
  }

  /** Handlers for `upgradeWebSocket`. */
  handlers(): WSEvents {
    let client: Client | undefined;
    return {
      onOpen: (_event, ws) => {
        client = {
          ws,
          lastSent: undefined,
          sessionIds: undefined,
          agentEvents: true,
          pending: [],
          watches: new Map(),
          timer: undefined,
        };
        this.clients.add(client);
        send(ws, {
          type: "hello",
          protocolVersion: UI_PROTOCOL_VERSION,
          serverVersion: CODEDEN_VERSION,
          seq: this.store.headSeq(),
        });
        send(ws, { type: "runner", ...this.runnerStatus() });
        const update = this.opts.updateStatus?.();
        if (update) send(ws, { type: "update", update });
      },
      onMessage: (event, ws) => {
        if (!client) return;
        const parsed = UiClientMessage.safeParse(safeJson(event.data));
        if (!parsed.success) {
          send(ws, { type: "error", error: { code: "bad_message", message: "Invalid message" } });
          return;
        }
        const msg = parsed.data;
        switch (msg.type) {
          case "ping":
            send(ws, { type: "pong", id: msg.id });
            break;
          case "unsubscribe":
            client.lastSent = undefined;
            client.pending = [];
            break;
          case "subscribe":
            this.subscribe(client, msg.fromSeq, msg.sessionIds, msg.agentEvents);
            break;
          case "watch_session":
            this.watch(client, msg.sessionId, msg.fromSeq, msg.threadIds);
            break;
          case "unwatch_session":
            client.watches.delete(msg.sessionId);
            break;
        }
      },
      onClose: () => {
        if (!client) return;
        clearTimeout(client.timer);
        this.clients.delete(client);
      },
    };
  }

  /** Push a runner status change to every client: the home runner's, and every runner. */
  broadcastRunner(status: RunnersStatus): void {
    for (const client of this.clients) send(client.ws, { type: "runner", ...status });
  }

  /** Push an update check or self-update change to every client (§16). */
  broadcastUpdate(update: UpdateStatus): void {
    for (const client of this.clients) send(client.ws, { type: "update", update });
  }

  close(): void {
    this.unsubscribe();
    for (const client of this.clients) {
      clearTimeout(client.timer);
      client.ws.close(1001, "server stopping");
    }
    this.clients.clear();
  }

  private subscribe(
    client: Client,
    fromSeq: number,
    sessionIds: string[] | undefined,
    agentEvents: boolean,
  ): void {
    const head = this.store.headSeq();
    client.pending = [];
    if (fromSeq > head) {
      send(client.ws, { type: "resync", reason: "server_restarted", seq: head });
      return;
    }
    if (head - fromSeq > MAX_CATCH_UP) {
      send(client.ws, { type: "resync", reason: "too_far_behind", seq: head });
      return;
    }
    client.sessionIds = sessionIds ? new Set(sessionIds) : undefined;
    client.agentEvents = agentEvents;
    let cursor = fromSeq;
    for (;;) {
      const batch = this.store.listAfter(cursor, BATCH, sessionIds);
      if (batch.length === 0) break;
      const visible = batch.filter((e) => this.visible(client, e));
      if (visible.length > 0) send(client.ws, { type: "events", events: this.present(visible) });
      cursor = batch.at(-1)?.seq ?? cursor;
      if (batch.length < BATCH) break;
    }
    client.lastSent = Math.max(cursor, head);
  }

  private watch(client: Client, sessionId: string, fromSeq: number, threadIds?: string[]): void {
    const head = this.store.headSeq();
    const watch: Watch = {
      threadIds: threadIds ? new Set(threadIds) : undefined,
      dirty: emptyDirty(),
    };
    client.watches.set(sessionId, watch);
    if (fromSeq > head) {
      send(client.ws, { type: "transcript_resync", sessionId, seq: head });
      return;
    }
    const events = this.store
      .listAfter(fromSeq, MAX_WATCH_REPLAY + 1, [sessionId])
      .filter((e) => e.sessionId === sessionId);
    if (events.length > MAX_WATCH_REPLAY) {
      send(client.ws, { type: "transcript_resync", sessionId, seq: head });
      return;
    }
    collectDirty(watch.dirty, events, sessionId, watch.threadIds);
    watch.dirty.seq = head;
    this.sendTranscript(client, sessionId, watch);
  }

  private visible(client: Client, e: RawEventEnvelope): boolean {
    if (!client.agentEvents && e.type.startsWith("agent.")) return false;
    const filter = client.sessionIds;
    return !filter || e.sessionId === null || filter.has(e.sessionId);
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const client of this.clients) {
      let schedule = false;
      const lastSent = client.lastSent;
      if (lastSent !== undefined) {
        for (const e of events) {
          if (e.seq > lastSent && this.visible(client, e)) client.pending.push(e);
        }
        const last = events.at(-1);
        if (last) client.lastSent = Math.max(lastSent, last.seq);
        schedule = client.pending.length > 0;
        if (client.pending.length > MAX_PENDING) {
          client.pending = [];
          client.lastSent = undefined;
          send(client.ws, { type: "resync", reason: "gap", seq: this.store.headSeq() });
          schedule = false;
        }
      }
      for (const [sessionId, watch] of client.watches) {
        collectDirty(watch.dirty, events, sessionId, watch.threadIds);
        if (isDirty(watch.dirty)) schedule = true;
      }
      if (schedule && !client.timer) {
        client.timer = setTimeout(() => this.flush(client), this.flushMs);
      }
    }
  }

  private flush(client: Client): void {
    client.timer = undefined;
    if (!this.clients.has(client)) return;
    if (client.pending.length > 0) {
      const events = this.present(client.pending);
      client.pending = [];
      send(client.ws, { type: "events", events });
    }
    for (const [sessionId, watch] of client.watches) {
      if (isDirty(watch.dirty)) this.sendTranscript(client, sessionId, watch);
    }
  }

  private sendTranscript(client: Client, sessionId: string, watch: Watch): void {
    send(client.ws, loadTranscript(this.db, sessionId, watch.dirty, this.artifacts));
    watch.dirty = emptyDirty();
  }

  /** Events as sent to a client: deltas merged, attachment paths mapped. */
  private present(events: RawEventEnvelope[]): RawEventEnvelope[] {
    return coalesceEvents(events).map((e) => clientEvent(e, this.artifacts));
  }
}

function send(ws: WSContext, msg: UiServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function safeJson(data: unknown): unknown {
  try {
    return typeof data === "string" ? JSON.parse(data) : undefined;
  } catch {
    return undefined;
  }
}
