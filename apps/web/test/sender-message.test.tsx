import { messageFrom, type UserInput } from "@codeden/contracts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessage } from "@/components/thread/messages";
import { renderWithClient } from "./utils";

const body = ["Please **rebase** first, then:", "", "1. Run `pnpm test`", "2. Open the PR"].join(
  "\n",
);

const digest = [
  '<codeden_status project="p1" at="2026-11-08T10:00:00.000Z">',
  "Running: none",
  "</codeden_status>",
].join("\n");

const render = (input: UserInput) =>
  renderWithClient(
    <UserMessage item={{ id: "u1", kind: "user_message", status: "completed", input }} />,
  );

/** The card's header, Markdown and that the raw sender line is gone. */
function expectSenderCard(name: string, label: string) {
  const card = screen.getByRole("article", { name });
  expect(within(card).getByText(label)).toBeTruthy();
  // The transcript's Markdown renderer marks bold with a data attribute on a span.
  expect(within(card).getByText("rebase").getAttribute("data-streamdown")).toBe("strong");
  expect(card.querySelector("ol")?.querySelectorAll("li")).toHaveLength(2);
  expect(within(card).getByText("pnpm test").tagName).toBe("CODE");
  expect(card.textContent).not.toContain("Message from");
  expect(card.textContent).not.toContain("**");
  return card;
}

const reducedMotion = (reduce: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );

afterEach(() => vi.restoreAllMocks());

describe("messages from a PM, the orchestrator, the factory, an automation or CodeDen", () => {
  it("renders a PM's message as Markdown under a Project manager header", () => {
    render(messageFrom("pm", body));
    const card = expectSenderCard("Message from the project manager", "Project manager");
    expect(card.getAttribute("data-sender")).toBe("pm");
  });

  it("gives an older message that only has the text line the same card", () => {
    render({ text: `Message from the orchestrator:\n${body}`, attachments: [] });
    expectSenderCard("Message from the orchestrator", "Orchestrator");
  });

  it("keeps folding the status digest of a role session above the card", () => {
    const { text, from } = messageFrom("orchestrator", body);
    render({ text: `${digest}\n\n${text}`, attachments: [], from });
    expectSenderCard("Message from the orchestrator", "Orchestrator");
    expect(screen.getByRole("button", { name: /Status sent to agent/ })).toBeTruthy();
    expect(screen.queryByText(/codeden_status/)).toBeNull();
  });

  it("leaves the user's own message as a plain bubble", () => {
    render({ text: body, attachments: [] });
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByTestId("sender-message")).toBeNull();
    const bubble = screen.getByText(/Please \*\*rebase\*\* first/);
    expect(bubble.className).toContain("whitespace-pre-wrap");
    expect(bubble.className).toContain("bg-message");
    expect(bubble.textContent).toBe(body);
    expect(bubble.querySelector("[data-streamdown]")).toBeNull();
  });

  it("renders a message from the factory, an automation or CodeDen as Markdown under its sender", () => {
    // Issue #53: these fell through to the plain-text bubble, showing literal `**` and backticks.
    const senders = [
      ["factory", "Message from the factory", "Factory"],
      ["automation", "Message from an automation", "Automation"],
      ["codeden", "Message from CodeDen", "CodeDen"],
    ] as const;
    for (const [from, name, label] of senders) {
      const { unmount } = render({ text: body, attachments: [], from });
      expect(expectSenderCard(name, label).getAttribute("data-sender")).toBe(from);
      unmount();
    }
  });

  it("renders a factory brief's tagged sections as Markdown, with no raw syntax or tags", () => {
    const brief = [
      "You are an agent of this project's software factory, working on issue #53: **Transcript**",
      "",
      "<issue>",
      "## Bug",
      "The first message shows **raw Markdown**.",
      "</issue>",
      "",
      "<vision>",
      "- It scales with the user",
      "</vision>",
    ].join("\n");
    render({ text: brief, attachments: [], from: "factory" });
    const card = screen.getByRole("article", { name: "Message from the factory" });
    expect(within(card).getByRole("heading", { name: "Bug" })).toBeTruthy();
    expect(within(card).getByText("raw Markdown").getAttribute("data-streamdown")).toBe("strong");
    expect(within(card).getByRole("listitem").textContent).toBe("It scales with the user");
    for (const raw of ["**", "## ", "<issue>", "</vision>", "- It"]) {
      expect(card.textContent).not.toContain(raw);
    }
  });

  it("keeps the tags inside indented code and list-nested code blocks", () => {
    const { unmount } = render({
      text: "Use this JSX:\n\n    <Button>\n      Save\n    </Button>",
      attachments: [],
      from: "factory",
    });
    const indented = screen.getByTestId("sender-message").querySelector("pre");
    expect(indented?.textContent).toContain("<Button>");
    expect(indented?.textContent).toContain("</Button>");
    unmount();

    render({
      text: "1. Use this markup:\n\n    ```html\n    <div>\n    ```",
      attachments: [],
      from: "factory",
    });
    const card = screen.getByTestId("sender-message");
    const code = card.querySelector("li pre");
    expect(code?.textContent).toContain("<div>");
    expect(card.textContent).not.toContain("```");
  });

  it("collapses a long brief after about 12 lines, with Show more", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step **${i + 1}**`).join("\n");
    render({ text: long, attachments: [], from: "pm" });
    const card = screen.getByTestId("sender-message");
    const toggle = within(card).getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector("[data-clipped]")?.className).toContain("max-h-64");
    fireEvent.click(toggle);
    expect(within(card).getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(card.querySelector("[data-clipped]")).toBeNull();
    // A short message has nothing to collapse.
    cleanup();
    render(messageFrom("pm", body));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("trusts a recorded sender over the text", () => {
    render({ text: `Message from the orchestrator:\n${body}`, attachments: [], from: "user" });
    expect(screen.queryByTestId("sender-message")).toBeNull();
  });

  it("sweeps a light along the border, and keeps it still under reduced motion", () => {
    reducedMotion(false);
    const { unmount } = render(messageFrom("pm", body));
    const moving = screen.getByTestId("sender-message");
    expect(moving.className).toContain("border-shimmer");
    expect(moving.className).toContain("animate-border-shimmer");
    unmount();

    reducedMotion(true);
    render(messageFrom("pm", body));
    const still = screen.getByTestId("sender-message");
    expect(still.className).toContain("border-shimmer");
    expect(still.className).not.toContain("animate-border-shimmer");
  });
});
