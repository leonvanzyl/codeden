import type { Automation, InboxItem } from "@codeden/contracts";
import { BEHAVIOUR_FIELDS } from "./definitions";

const MAX_VALUE = 120;

/** Inbox id of the notice about a PM's change to an automation; the next change replaces it. */
export function pmChangeInboxId(automationId: string): string {
  return `inbox:automation-changed:${automationId}`;
}

/** `path: before → after` for each trigger, action and guard setting that differs. */
export function automationChanges(before: Automation, after: Automation): string[] {
  const was = new Map<string, string>();
  const now = new Map<string, string>();
  for (const key of BEHAVIOUR_FIELDS) {
    flatten(before[key], key, was);
    flatten(after[key], key, now);
  }
  const out: string[] = [];
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(path) === now.get(path)) continue;
    out.push(`${path}: ${shorten(was.get(path))} → ${shorten(now.get(path))}`);
  }
  return out;
}

function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (value === undefined) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) flatten(v, `${path}.${key}`, out);
    return;
  }
  out.set(path, JSON.stringify(value));
}

function shorten(text: string | undefined): string {
  if (text === undefined) return "none";
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/**
 * The inbox item telling the user that the PM changed what an automation that was on does, so
 * it was switched off (§10): what changed, and that it runs again only once they switch it on.
 */
export function pmChangeInbox(
  before: Automation,
  after: Automation,
  by: { projectId: string; sessionId: string | null },
  now: string,
): InboxItem {
  const name = after.name.length > 80 ? `${after.name.slice(0, 79)}…` : after.name;
  return {
    id: pmChangeInboxId(after.id),
    kind: "message",
    status: "open",
    priority: "normal",
    notify: "needs_you",
    title: `Automation switched off: the project manager changed "${name}"`,
    body: [
      "The project manager changed what this automation does, so it was switched off. It runs again only once you switch it on in Automations.",
      `Changed: ${automationChanges(before, after).join("; ")}.`,
    ].join("\n"),
    projectId: by.projectId,
    sessionId: by.sessionId,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  };
}
