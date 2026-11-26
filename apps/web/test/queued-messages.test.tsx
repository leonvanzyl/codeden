import type { QueuedMessage, Session } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedMessages } from "@/components/thread/queued-messages";
import type { CodeDenClient } from "@/lib/api/client";
import { ApiRequestError } from "@/lib/api/http";
import { createMockClient } from "@/lib/api/mock";
import { queuePosition, senderLabel } from "@/lib/queue";
import { startRealtime } from "@/lib/realtime";
import { getDraft, useComposerStore } from "@/stores/composer";
import { renderWithClient } from "./utils";

const ts = "2026-11-08T10:00:00.000Z";
const queued = (id: string, text: string, from: QueuedMessage["from"] = "user"): QueuedMessage => ({
  id,
  sessionId: "s-q",
  input: { text, attachments: [] },
  from,
  createdAt: ts,
});

/** A mock client whose queue API is replaced by `queue`. */
function withQueue(queue: Partial<CodeDenClient["queue"]>): CodeDenClient {
  const client = createMockClient();
  return { ...client, queue: { ...client.queue, ...queue } };
}

const session = (over: Partial<Session> = {}) =>
  ({ id: "s-q", provider: "claude", role: "agent", ...over }) as Session;

afterEach(() => vi.restoreAllMocks());

describe("queue labels", () => {
  it("numbers positions and names senders", () => {
    expect([0, 1, 2, 3, 10, 11, 21].map(queuePosition)).toEqual([
      "Next",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "22nd",
    ]);
    expect(senderLabel("user")).toBeNull();
    expect(senderLabel("orchestrator")).toBe("From the orchestrator");
    expect(senderLabel("pm")).toBe("From the PM");
  });
});

describe("QueuedMessages", () => {
  it("renders nothing while the queue is empty", async () => {
    const { container } = renderWithClient(
      <QueuedMessages session={session()} running />,
      withQueue({ list: async () => [] }),
    );
    await waitFor(() =>
      expect(container.querySelector("[data-testid=queued-messages]")).toBeNull(),
    );
  });

  it("shows each message's position, sender and text with its actions", async () => {
    const list = vi.fn(async () => [
      queued("a", "Fix the tests too"),
      queued("b", "Message from the orchestrator:\nAlso bump the version", "orchestrator"),
    ]);
    renderWithClient(<QueuedMessages session={session()} running />, withQueue({ list }));
    const tray = await screen.findByRole("region", { name: "Queued messages" });
    expect(within(tray).getByText("2 queued")).toBeTruthy();
    const [first, second] = within(tray).getAllByTestId("queued-message");
    expect(within(first as HTMLElement).getByText("Next")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("Fix the tests too")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("2nd")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("From the orchestrator")).toBeTruthy();
    // The mock Claude provider can steer, so send-now is offered.
    await waitFor(() =>
      expect(within(first as HTMLElement).getByRole("button", { name: "Send now" })).toBeTruthy(),
    );
  });

  it("says how long the next message has waited, once that is a minute or more (#657)", async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    renderWithClient(
      <QueuedMessages session={session()} running />,
      withQueue({
        list: async () => [
          { ...queued("a", "status?", "orchestrator"), createdAt: at(15) },
          { ...queued("b", "later"), createdAt: at(2) },
        ],
      }),
    );
    const tray = await screen.findByRole("region", { name: "Queued messages" });
    expect(within(tray).getByText("next waiting 15m")).toBeTruthy();

    const { container } = renderWithClient(
      <QueuedMessages session={session({ id: "s-fresh" })} running />,
      withQueue({ list: async () => [{ ...queued("c", "just now"), createdAt: at(0) }] }),
    );
    await within(container).findByTestId("queued-message");
    expect(within(container).queryByText(/next waiting/)).toBeNull();
  });

  it("hides send-now when the provider cannot steer", async () => {
    renderWithClient(
      <QueuedMessages session={session({ provider: "no-steer" })} running />,
      withQueue({ list: async () => [queued("a", "later")] }),
    );
    const row = await screen.findByTestId("queued-message");
    expect(within(row).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("hides send-now while no turn runs: it only steers a running turn", async () => {
    renderWithClient(
      <QueuedMessages session={session()} running={false} />,
      withQueue({ list: async () => [queued("a", "next up")] }),
    );
    const row = await screen.findByTestId("queued-message");
    await waitFor(() => expect(within(row).getByRole("button", { name: "Delete" })).toBeTruthy());
    expect(within(row).queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("opens a queued message's image thumbnail in the image viewer", async () => {
    const message: QueuedMessage = {
      ...queued("a", "see this"),
      input: {
        text: "see this",
        attachments: [
          { type: "file", path: "notes.md" },
          {
            type: "image",
            mediaType: "image/png",
            name: "bug.png",
            source: { type: "artifact", artifactId: "art-q" },
          },
        ],
      },
    };
    const client = withQueue({ list: async () => [message] });
    renderWithClient(<QueuedMessages session={session()} running={false} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "View bug.png" }));
    const viewer = screen.getByRole("dialog");
    expect(within(viewer).getByRole("img", { name: "bug.png" }).getAttribute("src")).toBe(
      client.artifactUrl("art-q"),
    );
    expect(within(viewer).queryByText(/\/ 2/)).toBeNull();
    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("send-now steers the running turn through the mock; a dropped message answers 409", async () => {
    const client = createMockClient();
    const started = await client.startSession({ projectId: "p-storefront", input: { text: "Go" } });
    if (started.status !== "started") throw new Error("not started");
    const id = started.sessionId;
    await client.sendMessage(id, { text: "steer me" }, "queue");
    await client.sendMessage(id, { text: "wait for me" }, "queue");
    const [first, second] = await client.queue.list(id);
    await expect(client.queue.sendNow(id, first?.id ?? "")).resolves.toEqual({ status: "steered" });
    expect((await client.queue.list(id)).map((m) => m.input.text)).toEqual(["wait for me"]);
    await client.interrupt(id);
    await expect(client.queue.sendNow(id, second?.id ?? "")).rejects.toMatchObject({
      status: 409,
      code: "no_longer_queued",
    });
  });

  it("edits inline and deletes", async () => {
    let items = [queued("a", "first"), queued("b", "second")];
    const edit = vi.fn(async (_s: string, id: string, text: string) => {
      items = items.map((m) => (m.id === id ? { ...m, input: { ...m.input, text } } : m));
      return items.find((m) => m.id === id) as QueuedMessage;
    });
    const remove = vi.fn(async (_s: string, id: string) => {
      items = items.filter((m) => m.id !== id);
    });
    renderWithClient(
      <QueuedMessages session={session()} running />,
      withQueue({ list: async () => items, edit, remove }),
    );
    const [first] = await screen.findAllByTestId("queued-message");
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(box, { target: { value: "first, but better" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("first, but better");
    expect(edit).toHaveBeenCalledWith("s-q", "a", "first, but better");

    const second = screen.getAllByTestId("queued-message")[1] as HTMLElement;
    fireEvent.click(within(second).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getAllByTestId("queued-message")).toHaveLength(1));
    expect(remove).toHaveBeenCalledWith("s-q", "b");
  });

  it("says so when delivery took the message first (409)", async () => {
    const error = vi.spyOn(toast, "error");
    let items = [queued("a", "racing")];
    const remove = vi.fn(async () => {
      items = [];
      throw new ApiRequestError(409, "already_sent", "This message was already sent");
    });
    renderWithClient(
      <QueuedMessages session={session()} running />,
      withQueue({ list: async () => items, remove }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("This message was already sent"));
    await waitFor(() => expect(screen.queryByTestId("queued-message")).toBeNull());
  });
});

describe("queue with the mock client", () => {
  it("queues behind a running turn and moves dropped text back into the composer", async () => {
    const client = createMockClient();
    const started = await client.startSession({
      projectId: "p-shop",
      input: { text: "Work on it" },
    });
    if (started.status !== "started") throw new Error("not started");
    const id = started.sessionId;
    await client.sendMessage(id, { text: "Then write the changelog" }, "queue");
    expect((await client.queue.list(id)).map((m) => m.input.text)).toEqual([
      "Then write the changelog",
    ]);

    const { queryClient } = renderWithClient(
      <QueuedMessages session={session({ id })} running />,
      client,
    );
    const stop = startRealtime(client, queryClient);
    try {
      await screen.findByText("Then write the changelog");
      await client.interrupt(id);
      await waitFor(() => expect(screen.queryByTestId("queued-messages")).toBeNull());
      await waitFor(() =>
        expect(getDraft(useComposerStore.getState(), id).text).toBe("Then write the changelog"),
      );
    } finally {
      stop();
    }
  });
});
