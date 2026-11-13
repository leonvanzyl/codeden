import type { StartSessionResponse } from "@codeden/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClientProvider } from "@/lib/api";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { NewSessionPage } from "@/routes/new-session";
import { getDraft, newSessionDraftKey, useComposerStore } from "@/stores/composer";
import { useNewSessionStore } from "@/stores/new-session";
import { renderWithClient } from "./utils";

const PROJECT = "p-storefront";
const KEY = newSessionDraftKey(PROJECT);
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pastedImage = {
  type: "image",
  mediaType: "image/png",
  name: "image.png",
  source: { type: "base64", data: PNG_B64 },
};

function pasteImage(target: HTMLElement) {
  const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  const file = new File([bytes], "image.png", { type: "image/png" });
  fireEvent.paste(target, { clipboardData: { files: [file] } });
}

type Start = CodeDenClient["startSession"];

/** A start that matched running work with the same key (not persisted: no `conflictId`). */
const conflict: StartSessionResponse = {
  status: "conflict",
  existing: [
    {
      kind: "session",
      id: "s-old",
      sessionId: "s-old",
      projectId: PROJECT,
      startedBy: { kind: "user" },
      purpose: "Hold the work key",
      workKey: "issue:9",
      scope: { projectId: PROJECT },
      progress: null,
      status: "running",
      startedAt: "2026-11-12T10:00:00.000Z",
    },
  ],
};

function clientWith(startSession: Start): CodeDenClient {
  return { ...createMockClient(), startSession };
}

async function openDraft(client: CodeDenClient) {
  renderWithClient(<NewSessionPage projectId={PROJECT} />, client, { withRouter: true });
  await screen.findByTestId("new-session");
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

beforeEach(() => {
  localStorage.clear();
  useComposerStore.setState({ drafts: {} });
  useNewSessionStore.setState({ drafts: {}, firstMessages: {} });
});

describe("the New session draft", () => {
  it("starts the session with the text, a pasted image and the work key, then becomes it", async () => {
    const start = vi.fn<Start>(async () => ({ status: "started", sessionId: "s-new" }));
    useNewSessionStore.getState().setWorkKey(PROJECT, "  issue:9 ");
    const box = await openDraft(clientWith(start));
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByTestId("work-key-chip").textContent).toBe("issue:9");

    fireEvent.change(box, { target: { value: "Add a README section" } });
    pasteImage(box);
    await screen.findByRole("button", { name: "Remove image.png" });
    // Typing creates nothing: the session starts with the first send.
    expect(start).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const request = start.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      projectId: PROJECT,
      input: { text: "Add a README section", attachments: [pastedImage] },
      workKey: "issue:9",
    });
    expect(request?.provider).toEqual(expect.any(String));

    // The first message waits for the session view; the draft is gone.
    await waitFor(() =>
      expect(useNewSessionStore.getState().firstMessages["s-new"]).toEqual(request?.input),
    );
    expect(getDraft(useComposerStore.getState(), KEY)).toEqual({ text: "", attachments: [] });
    expect(useNewSessionStore.getState().drafts[PROJECT]).toBeUndefined();
  });

  it("shows a duplicate-work conflict above the composer and keeps the draft", async () => {
    const box = await openDraft(clientWith(vi.fn<Start>(async () => conflict)));
    fireEvent.change(box, { target: { value: "Do the same thing again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const card = await screen.findByTestId("conflict-card");
    expect(card.textContent).toContain("Hold the work key");
    expect(card.textContent).toContain("Do the same thing again");
    expect(box.value).toBe("Do the same thing again");
    expect(useNewSessionStore.getState().firstMessages).toEqual({});
  });

  it("keeps the text and the attachments when the start fails", async () => {
    const start = vi.fn<Start>(async () => {
      throw new Error("Runner offline");
    });
    const box = await openDraft(clientWith(start));
    fireEvent.change(box, { target: { value: "Fix the flaky test" } });
    pasteImage(box);
    await screen.findByRole("button", { name: "Remove image.png" });

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(box.value).toBe("Fix the flaky test");
    expect(getDraft(useComposerStore.getState(), KEY).attachments).toHaveLength(1);
  });

  it("lists the project's `/` commands for the draft's provider before the session exists", async () => {
    const base = createMockClient();
    const list = vi.fn<CodeDenClient["listProjectSlashCommands"]>(async () => [
      { name: "release", description: "Cut a release", kind: "command" },
    ]);
    const box = await openDraft({ ...base, listProjectSlashCommands: list });
    fireEvent.change(box, { target: { value: "/rel" } });
    expect(await screen.findByText("/release")).toBeTruthy();
    expect(list).toHaveBeenCalledWith(PROJECT, expect.any(String));
  });
});

/**
 * The draft inside a router with the project page behind it, as when New session is clicked on
 * project home: the draft becomes the session in place, so Back leads to the project page.
 */
async function openDraftInHistory(client: CodeDenClient) {
  const root = createRootRoute({ component: Outlet });
  const project = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId",
    component: () => <p>Project home</p>,
  });
  const draft = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/new",
    component: () => <NewSessionPage projectId={PROJECT} />,
  });
  const session = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$sessionId",
    component: () => <p>Session view</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([project, draft, session]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${PROJECT}`, `/projects/${PROJECT}/new`],
    }),
  });
  render(
    <ClientProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ClientProvider>,
  );
  await screen.findByTestId("new-session");
  const box = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  return { router, box };
}

describe("the draft becoming its session (history)", () => {
  const pathname = (router: { state: { location: { pathname: string } } }) =>
    router.state.location.pathname;

  it("replaces the draft with the session on a direct start", async () => {
    const start = vi.fn<Start>(async () => ({ status: "started", sessionId: "s-new" }));
    const { router, box } = await openDraftInHistory(clientWith(start));
    fireEvent.change(box, { target: { value: "Write the docs" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(pathname(router)).toBe("/sessions/s-new"));

    act(() => router.history.back());
    await waitFor(() => expect(pathname(router)).toBe(`/projects/${PROJECT}`));
  });

  it("replaces the draft with the session when a conflict is resolved with Wait", async () => {
    const start = vi.fn<Start>(async (req) =>
      req.conflict ? { status: "queued", sessionId: "s-queued", behind: ["s-old"] } : conflict,
    );
    const { router, box } = await openDraftInHistory(clientWith(start));
    fireEvent.change(box, { target: { value: "Do the same thing again" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const card = await screen.findByTestId("conflict-card");
    fireEvent.click(within(card).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(pathname(router)).toBe("/sessions/s-queued"));
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ conflict: expect.objectContaining({ resolution: "wait" }) }),
    );
    // The draft is now that session: its first message waits for the view, the draft is gone.
    expect(useNewSessionStore.getState().firstMessages["s-queued"]).toMatchObject({
      text: "Do the same thing again",
    });
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe("");

    // Back leads to where New session was opened, not to an emptied draft.
    act(() => router.history.back());
    await waitFor(() => expect(pathname(router)).toBe(`/projects/${PROJECT}`));
    expect(await screen.findByText("Project home")).toBeTruthy();
  });
});
