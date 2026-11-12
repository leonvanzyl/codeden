import {
  defaultSettings,
  type EventEnvelope,
  type InboxItem,
  type Settings,
  type Snapshot,
} from "@codeden/contracts";
import { vi } from "vitest";
import type { AttentionEffects } from "@/lib/attention/attention";

const ts = "2026-11-08T10:00:00.000Z";

export function inboxItem(
  id: string,
  kind: InboxItem["kind"],
  over: Partial<InboxItem> = {},
): InboxItem {
  return {
    id,
    kind,
    status: "open",
    priority: "normal",
    notify: "needs_you",
    title: `Item ${id}`,
    body: null,
    projectId: "p1",
    sessionId: "s1",
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: ts,
    updatedAt: ts,
    resolvedAt: null,
    resolution: null,
    ...over,
  };
}

export function snapshot(
  seq: number,
  inbox: InboxItem[],
  notifications: Partial<Settings["notifications"]> = {},
): Snapshot {
  const settings = defaultSettings();
  return {
    seq,
    serverVersion: "0.0.0",
    generatedAt: ts,
    settings: { ...settings, notifications: { ...settings.notifications, ...notifications } },
    projects: [],
    sessions: [],
    inbox,
    automations: [],
    scheduled: [],
    runner: { state: "disabled", runnerId: null, version: null, providers: [], lastError: null },
  };
}

export function created(seq: number, item: InboxItem): EventEnvelope {
  return { seq, sessionId: item.sessionId, ts, type: "inbox.created", payload: { item } };
}

export function updated(seq: number, item: InboxItem): EventEnvelope {
  return { seq, sessionId: item.sessionId, ts, type: "inbox.updated", payload: { item } };
}

export function fakeEffects(canOffer = false) {
  return {
    chime: vi.fn(),
    showToast: vi.fn(),
    dismissToast: vi.fn(),
    setFavicon: vi.fn(),
    setTitle: vi.fn(),
    canOfferNotifications: vi.fn(() => canOffer),
  } satisfies AttentionEffects;
}
