import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/composer/composer";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { getDraft, useComposerStore } from "@/stores/composer";
import { renderWithClient } from "./utils";

const PROJECT = "p-storefront";
const KEY = "a11y";

function renderComposer() {
  const client: CodeDenClient = {
    ...createMockClient(),
    listProjectSlashCommands: vi.fn(async () => [
      { name: "release", description: "Cut a release", kind: "command" as const },
      { name: "review", description: "Review the diff", kind: "skill" as const },
    ]),
    searchProjectMentions: vi.fn(async () => [
      { path: "README.md", kind: "file" as const },
      { path: "src", kind: "dir" as const },
    ]),
  };
  renderWithClient(
    <Composer
      draftKey={KEY}
      source={{ kind: "project", projectId: PROJECT, provider: "fake" }}
      placeholder="Message the agent"
      options={null}
      sending={false}
      onSend={vi.fn()}
    />,
    client,
  );
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

/** The composer's live region for the menu (the only status region it renders). */
const status = () => screen.getByRole("status");

beforeEach(() => {
  useComposerStore.setState({ drafts: {} });
});

describe("the composer's `/` and `@` menu for screen readers", () => {
  it("is a collapsed list combobox until a trigger is typed", () => {
    const box = renderComposer();
    expect(box.getAttribute("aria-autocomplete")).toBe("list");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("aria-controls")).toBe(false);
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("ties the box to the named `/` menu and follows the highlighted option", async () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "/re" } });

    const list = await screen.findByRole("listbox", { name: "Commands & skills" });
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(list.id).not.toBe("");
    expect(box.getAttribute("aria-controls")).toBe(list.id);

    // Each option is named by its label and kind, and has an id to point at.
    const release = await screen.findByRole("option", { name: "/release, command" });
    const review = screen.getByRole("option", { name: "/review, skill" });
    expect(release.id).not.toBe("");
    expect(review.id).not.toBe(release.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(release.id);
    await waitFor(() => expect(status().textContent).toBe("2 results"));

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(review.id);
    expect(review.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(release.id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.getAttribute("aria-activedescendant")).toBe(review.id);

    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("aria-controls")).toBe(false);
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("announces an empty list as no matches, with nothing highlighted", async () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "/zzz" } });
    await waitFor(() => expect(status().textContent).toBe("No matches"));
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("names the `@` menu and its rows after what they are, and Enter still inserts", async () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "see @REA" } });
    const list = await screen.findByRole("listbox", { name: "Files" });
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    const file = await screen.findByRole("option", { name: "README.md, file" });
    expect(screen.getByRole("option", { name: "src, folder" })).toBeTruthy();
    expect(box.getAttribute("aria-activedescendant")).toBe(file.id);
    await waitFor(() => expect(status().textContent).toBe("2 results"));

    fireEvent.keyDown(box, { key: "Enter" });
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe("see @README.md ");
  });
});
