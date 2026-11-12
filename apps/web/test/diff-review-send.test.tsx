import type { Session } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewBar } from "@/components/workbench/diff-review";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { sessionComments, useDiffReviewStore } from "@/stores/diff-review";
import { renderWithClient } from "./utils";

const sid = "s-review";
const store = () => useDiffReviewStore.getState();
const list = () => sessionComments(store(), sid);
const bodies = () => list().map((c) => c.draft ?? c.body);

/** Start a comment on new line `line` and, unless `text` is empty, save it with that text. */
function comment(text: string, line = 1): string {
  store().start(sid, {
    path: "src/a.ts",
    scopeKey: "session",
    range: { start: line, side: "additions", end: line, endSide: "additions" },
    quote: [`+line ${line}`],
  });
  const id = list().at(-1)?.id ?? "";
  if (text) {
    store().setDraft(sid, id, text);
    store().save(sid, id);
  }
  return id;
}

/** A request that settles only when the test says so. */
function deferred() {
  let resolve: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  useDiffReviewStore.setState({ comments: {}, sending: {} });
  vi.restoreAllMocks();
});

describe("sendReview", () => {
  it("sends the saved comments as one message, once, while a review is in flight", async () => {
    comment("Use a map.", 3);
    comment("Rename this.", 1);
    const request = deferred();
    const deliver = vi.fn((_text: string) => request.promise);
    const first = store().sendReview(sid, deliver);
    expect(await store().sendReview(sid, deliver)).toBe("busy");
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = deliver.mock.calls[0]?.[0] ?? "";
    expect(text).toMatch(/^2 review comments/);
    expect(text.indexOf("Rename this.")).toBeLessThan(text.indexOf("Use a map."));
    request.resolve();
    expect(await first).toBe("sent");
    expect(list()).toEqual([]);
    expect(store().sending[sid]).toBeUndefined();
  });

  it("locks the sent comments until the review lands, and keeps what was written meanwhile", async () => {
    const id = comment("Original comment");
    const request = deferred();
    const sending = store().sendReview(sid, () => request.promise);
    // Edits, deletes and discards of a comment on its way are refused.
    store().edit(sid, id);
    store().setDraft(sid, id, "Additional unsent change");
    store().save(sid, id);
    store().remove(sid, [id]);
    store().clear(sid);
    expect(list()).toMatchObject([{ id, body: "Original comment", draft: undefined }]);
    // A comment started while sending is not part of the review.
    comment("Written while sending", 7);
    request.resolve();
    await sending;
    expect(bodies()).toEqual(["Written while sending"]);
  });

  it("clears editors left empty when it was sent, but not ones typed into since", async () => {
    comment("Saved");
    comment("", 2);
    const typed = comment("", 3);
    const request = deferred();
    const sending = store().sendReview(sid, () => request.promise);
    store().setDraft(sid, typed, "Started typing");
    request.resolve();
    await sending;
    expect(list()).toMatchObject([{ id: typed, body: "", draft: "Started typing" }]);
  });

  it("keeps every comment and unlocks them when sending fails", async () => {
    const id = comment("Keep me");
    comment("", 2);
    const request = deferred();
    const sending = store().sendReview(sid, () => request.promise);
    request.reject(new Error("offline"));
    await expect(sending).rejects.toThrow("offline");
    expect(store().sending[sid]).toBeUndefined();
    expect(list()).toHaveLength(2);
    store().edit(sid, id);
    expect(list()[0]?.draft).toBe("Keep me");
  });

  it("sends nothing while an editor has unsaved text, or when nothing is saved", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    comment("", 1);
    expect(await store().sendReview(sid, deliver)).toBe("empty");
    const id = comment("Saved", 2);
    store().edit(sid, id);
    store().setDraft(sid, id, "Saved, then changed");
    expect(await store().sendReview(sid, deliver)).toBe("unsaved");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("ReviewBar", () => {
  const session = { id: sid, role: "agent", status: "idle", provider: "claude" } as Session;

  it("can't send the same review twice when the panel is left and reopened mid-send", async () => {
    comment("Guard the error path too.");
    const request = deferred();
    const sendMessage = vi.fn((..._args: Parameters<CodeDenClient["sendMessage"]>) => {
      return request.promise;
    });
    const client = { ...createMockClient(), sendMessage };
    const first = renderWithClient(<ReviewBar session={session} scopeKey="session" />, client);
    fireEvent.click(screen.getByRole("button", { name: /Send to agent/ }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toBe("queue");
    first.unmount();

    // Back on the Diff tab before the request settles: still sending, Send stays disabled.
    renderWithClient(<ReviewBar session={session} scopeKey="session" />, client);
    const button = screen.getByRole("button", { name: /Sending/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    request.resolve();
    await waitFor(() => expect(screen.queryByTestId("diff-review-bar")).toBeNull());
    expect(list()).toEqual([]);
  });
});
