import type { Attachment, ItemOf } from "@codeden/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  SharedArtifactCard,
  sharedArtifactOf,
} from "@/components/thread/cards/shared-artifact-card";
import { UserMessage } from "@/components/thread/messages";
import { WorkGroup } from "@/components/thread/work/work-group";
import type { WorkEntry } from "@/lib/transcript/timeline";
import { renderWithClient } from "./utils";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const message = (attachments: Attachment[]) => (
  <UserMessage
    item={{
      id: "u1",
      kind: "user_message",
      status: "completed",
      input: { text: "see attached", attachments },
    }}
  />
);

const pasted: Attachment = {
  type: "image",
  mediaType: "image/png",
  name: "screenshot.png",
  source: { type: "base64", data: PNG_B64 },
};
const stored: Attachment = {
  type: "image",
  mediaType: "image/png",
  name: "stored.png",
  source: { type: "artifact", artifactId: "art-1" },
};

const viewer = () => screen.getByRole("dialog");

describe("image viewer", () => {
  it("opens a pasted screenshot full size from its thumbnail and closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithClient(message([pasted]));
    const thumbnail = screen.getByRole("button", { name: "View screenshot.png" });
    expect(thumbnail.closest("a")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(thumbnail);
    const dialog = viewer();
    expect(within(dialog).getByRole("heading", { name: "screenshot.png" })).toBeTruthy();
    const full = within(dialog).getByRole("img", { name: "screenshot.png" });
    expect(full.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(full.className).toContain("object-contain");
    // A data: URL can't be navigated to, so it downloads instead.
    const download = within(dialog).getByRole("link", { name: /Download/ });
    expect(download.getAttribute("href")).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(download.getAttribute("download")).toBe("screenshot.png");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
  });

  it("opens with the keyboard and steps through a message's images with the arrow keys", async () => {
    const user = userEvent.setup();
    const { client } = renderWithClient(
      message([pasted, { type: "file", path: "notes.md" }, stored]),
    );
    screen.getByRole("button", { name: "View stored.png" }).focus();
    await user.keyboard("{Enter}");
    expect(within(viewer()).getByText("2 / 2")).toBeTruthy();
    expect(within(viewer()).getByRole("img").getAttribute("src")).toBe(client.artifactUrl("art-1"));

    await user.keyboard("{ArrowRight}");
    expect(within(viewer()).getByText("1 / 2")).toBeTruthy();
    expect(within(viewer()).getByRole("heading", { name: "screenshot.png" })).toBeTruthy();

    await user.click(within(viewer()).getByRole("button", { name: "Previous image" }));
    expect(within(viewer()).getByRole("heading", { name: "stored.png" })).toBeTruthy();

    await user.click(within(viewer()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View stored.png" }));
  });

  it("opens an image an agent shared, with its caption, and closes on a backdrop click", async () => {
    const user = userEvent.setup();
    const item: ItemOf<"notice"> = {
      id: "n1",
      kind: "notice",
      status: "completed",
      level: "info",
      code: "shared_artifact",
      message: "The new settings page",
      data: { artifactId: "art-9", name: "settings.png", mediaType: "image/png" },
    };
    const artifact = sharedArtifactOf(item);
    if (!artifact) throw new Error("expected a shared artifact");
    const { client } = renderWithClient(<SharedArtifactCard item={item} artifact={artifact} />);

    await user.click(screen.getByRole("button", { name: "View settings.png" }));
    const dialog = viewer();
    const full = within(dialog).getByRole("img", { name: "The new settings page" });
    expect(full.getAttribute("src")).toBe(client.artifactUrl("art-9"));
    expect(within(dialog).getByText("The new settings page")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /Download/ })
        .getAttribute("href"),
    ).toBe(client.artifactUrl("art-9"));
    // Clicking the image itself keeps the viewer open; the empty space around it closes it.
    await user.click(full);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await user.click(full.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a generated image from a work group", async () => {
    const user = userEvent.setup();
    const entry: WorkEntry = {
      id: "g1",
      kind: "tool_call",
      toolKind: "mcp",
      status: "completed",
      toolName: "mcp__codeden__generate_image",
      server: "codeden",
      tool: "generate_image",
      title: "A hero image",
      output: { text: JSON.stringify({ artifactIds: ["gen-1"] }), truncated: false },
    };
    const { client } = renderWithClient(
      <WorkGroup sessionId="s1" entries={[entry]} live={false} />,
    );
    await user.click(screen.getByRole("button", { name: "View Generated image" }));
    expect(within(viewer()).getByRole("img").getAttribute("src")).toBe(client.artifactUrl("gen-1"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
