import {
  ConflictDecision,
  type ConflictRecord,
  type StartSessionRequestInit,
  type StartSessionResponse,
} from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { NewSessionPage } from "@/routes/new-session";
import { useComposerStore } from "@/stores/composer";
import { useNewSessionStore } from "@/stores/new-session";
import { renderWithClient } from "./utils";

const PROJECT = "p-storefront";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function pasteImage(target: HTMLElement) {
  const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  const file = new File([bytes], "image.png", { type: "image/png" });
  fireEvent.paste(target, { clipboardData: { files: [file] } });
}

const running = {
  kind: "session" as const,
  id: "s-old",
  sessionId: "s-old",
  projectId: PROJECT,
  startedBy: { kind: "user" as const },
  purpose: "Hold the work key",
  workKey: "issue:9",
  scope: { projectId: PROJECT },
  progress: null,
  status: "running" as const,
  startedAt: "2026-11-12T10:00:00.000Z",
};

/**
 * The server's side of a New session start that matches running work, as `POST /api/sessions`
 * and `ConflictService` do it: every conflicting start is persisted (409 with `conflictId`) and
 * closes the open conflict it `replacesConflict`; resolving a conflict retries the start request
 * saved with it, or the `start` sent with the decision. The inbox API fails, so nothing may
 * depend on the browser closing a conflict itself.
 */
function fakeServer() {
  const conflicts: ConflictRecord[] = [];
  /** Every start request the server received, and every session it started. */
  const requests: StartSessionRequestInit[] = [];
  const started: StartSessionRequestInit[] = [];
  let n = 0;
  const startWith = (req: StartSessionRequestInit): StartSessionResponse => {
    started.push(req);
    return { status: "queued", sessionId: `s-new-${started.length}`, behind: ["s-old"] };
  };
  const client: CodeDenClient = {
    ...createMockClient(),
    async startSession(req) {
      requests.push(req);
      const replaced = conflicts.find((c) => c.id === req.replacesConflict);
      if (replaced?.status === "open") replaced.status = "dismissed";
      if (req.conflict) return startWith(req);
      n += 1;
      const id = `conflict:${n}`;
      conflicts.push({
        id,
        projectId: PROJECT,
        request: {
          purpose: req.input?.text.split("\n")[0] ?? "New session",
          workKey: req.workKey ?? "issue:9",
          startedBy: { kind: "user" },
        },
        existing: [running],
        start: JSON.parse(JSON.stringify(req)),
        status: "open",
        resolution: null,
        outcome: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      return { status: "conflict", existing: [running], conflictId: id };
    },
    async listConflicts() {
      return conflicts.filter((c) => c.status === "open");
    },
    async resolveConflict(id, request) {
      const record = conflicts.find((c) => c.id === id);
      if (record?.status !== "open") throw new Error("The conflict was already resolved");
      const decision = ConflictDecision.parse(request);
      const result = startWith({
        ...(request.start ?? (record.start as StartSessionRequestInit)),
        conflict: decision,
      });
      record.status = "resolved";
      record.resolution = decision;
      return { conflict: record, result };
    },
    async resolveInbox() {
      throw new Error("Inbox unavailable");
    },
  };
  const open = () => conflicts.filter((c) => c.status === "open");
  return { client, conflicts, requests, started, open };
}

const buttons = (card: HTMLElement) =>
  ["Wait", "Join", "Force…"].map(
    (name) => within(card).getByRole("button", { name }) as HTMLButtonElement,
  );

async function openDraft(client: CodeDenClient) {
  renderWithClient(<NewSessionPage projectId={PROJECT} />, client, { withRouter: true });
  await screen.findByTestId("new-session");
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

beforeEach(() => {
  localStorage.clear();
  useComposerStore.setState({ drafts: {} });
  useNewSessionStore.setState({ drafts: {}, firstMessages: {} });
  useNewSessionStore.getState().setWorkKey(PROJECT, "issue:9");
});

describe("a New session conflict while the draft is still editable (#169)", () => {
  it("starts what the draft says now when Wait is clicked after an edit", async () => {
    const server = fakeServer();
    const box = await openDraft(server.client);
    fireEvent.change(box, { target: { value: "First wording" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const card = await screen.findByTestId("conflict-card");

    // The composer stays usable under the card: edit the text and paste a screenshot.
    fireEvent.change(box, { target: { value: "Better wording, see the screenshot" } });
    pasteImage(box);
    await screen.findByRole("button", { name: "Remove image.png" });
    // The card names what Wait would start: the draft as it is now.
    expect(card.textContent).toContain("Better wording, see the screenshot");

    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(server.started).toHaveLength(1));
    const edited = {
      text: "Better wording, see the screenshot",
      attachments: [{ type: "image", name: "image.png" }],
    };
    expect(server.started[0]?.input).toMatchObject(edited);
    expect(server.started[0]?.conflict).toMatchObject({ resolution: "wait" });
    expect(server.open()).toEqual([]);
    // The session's first message is the edited one too.
    await waitFor(() =>
      expect(useNewSessionStore.getState().firstMessages["s-new-1"]).toMatchObject(edited),
    );
  });

  it("replaces the open conflict when the draft is sent again while the card is up", async () => {
    const server = fakeServer();
    const box = await openDraft(server.client);
    fireEvent.change(box, { target: { value: "First wording" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("conflict-card");

    fireEvent.change(box, { target: { value: "Second wording" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // The new send names the conflict it replaces, so the server closes it with the new one;
    // nothing depends on a separate inbox call (which fails here).
    await waitFor(() => expect(server.conflicts).toHaveLength(2));
    expect(server.requests[1]).toMatchObject({
      input: { text: "Second wording" },
      replacesConflict: "conflict:1",
    });
    expect(server.open().map((c) => c.request.purpose)).toEqual(["Second wording"]);

    // The card now answers the new conflict.
    const card = screen.getByTestId("conflict-card");
    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(server.started).toHaveLength(1));
    expect(server.started[0]?.input?.text).toBe("Second wording");
    expect(server.conflicts.map((c) => c.status)).toEqual(["dismissed", "resolved"]);
  });

  it("starts nothing from a draft whose text and image were removed", async () => {
    const server = fakeServer();
    const box = await openDraft(server.client);
    fireEvent.change(box, { target: { value: "First wording" } });
    pasteImage(box);
    await screen.findByRole("button", { name: "Remove image.png" });
    fireEvent.keyDown(box, { key: "Enter" });
    const card = await screen.findByTestId("conflict-card");

    // Empty the composer: the message that was sent must not come back.
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove image.png" }));
    await waitFor(() => expect(buttons(card).every((b) => b.disabled)).toBe(true));
    expect(card.textContent).toContain("The composer is empty");
    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    expect(server.started).toEqual([]);
    // Skip still works.
    expect((within(card).getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    // With a task again, Wait starts exactly what the composer holds.
    fireEvent.change(box, { target: { value: "Only text now" } });
    await waitFor(() => expect(buttons(card)[0]?.disabled).toBe(false));
    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(server.started).toHaveLength(1));
    expect(server.started[0]?.input).toEqual({ text: "Only text now", attachments: [] });
  });

  it("starts nothing from an image-only draft whose last image was removed", async () => {
    const server = fakeServer();
    const box = await openDraft(server.client);
    pasteImage(box);
    await screen.findByRole("button", { name: "Remove image.png" });
    fireEvent.keyDown(box, { key: "Enter" });
    const card = await screen.findByTestId("conflict-card");
    expect(buttons(card).some((b) => b.disabled)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove image.png" }));
    await waitFor(() => expect(buttons(card).every((b) => b.disabled)).toBe(true));
    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    expect(server.started).toEqual([]);
    expect(server.open()).toHaveLength(1);
  });
});
