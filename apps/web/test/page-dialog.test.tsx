import type { BrowserDialog, BrowserTab } from "@codeden/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageDialogLayer } from "@/components/workbench/browser/page-dialog";

const tabs: BrowserTab[] = [
  { tabId: "t1", url: "http://localhost:5173/items", title: "Items", active: true },
  { tabId: "t2", url: "http://localhost:5173/admin", title: "Admin", active: false },
];
const prompt: BrowserDialog = {
  dialogId: "d00000001",
  tabId: "t1",
  type: "prompt",
  message: "New name?",
  defaultValue: "draft",
};
const elsewhere: BrowserDialog = {
  dialogId: "d00000002",
  tabId: "t2",
  type: "confirm",
  message: "Leave the admin page?",
};

/** The prompt's field and the OK button of the card shown now. */
const field = () => screen.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
const ok = () => screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;

function layer(dialogs: BrowserDialog[], onAnswer = vi.fn(() => true)) {
  return <PageDialogLayer dialogs={dialogs} tabs={tabs} activeTabId="t1" onAnswer={onAnswer} />;
}

describe("page dialog in the browser panel", () => {
  it("keeps what was typed into a prompt while dialogs on other tabs come and go", async () => {
    const user = userEvent.setup();
    const view = render(layer([prompt]));
    await user.clear(field());
    await user.type(field(), "My unsaved name");

    // Each update is a new list (as from the server); the prompt itself is unchanged.
    view.rerender(layer([{ ...prompt }, elsewhere]));
    view.rerender(layer([{ ...prompt }]));
    expect(field().value).toBe("My unsaved name");

    // A new dialog on the tab gets a fresh card.
    view.rerender(layer([{ ...prompt, dialogId: "d00000003" }]));
    expect(field().value).toBe("draft");
  });

  it("answers the dialog it shows by its id, once, unless the answer could not be sent", async () => {
    const user = userEvent.setup();
    const offline = vi.fn(() => false);
    const view = render(layer([prompt], offline));
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(offline).toHaveBeenCalledWith("d00000001", true, "draft");
    // Not sent (disconnected): still answerable.
    expect(ok().disabled).toBe(false);

    const online = vi.fn(() => true);
    view.rerender(layer([prompt], online));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(online).toHaveBeenCalledWith("d00000001", false, undefined);
    expect(ok().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(online).toHaveBeenCalledTimes(1);
  });
});
