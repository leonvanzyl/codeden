import type { ItemOf, UserQuestion } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/** An MCP server's form on the question card (#235): number fields, and how it ended. */
describe("QuestionCard for an MCP server's form", () => {
  const replicas: UserQuestion = {
    id: "replicas",
    header: "Replicas",
    question: "deploy asks: How many replicas? (a whole number)",
    options: [],
    multiSelect: false,
    allowFreeText: true,
    format: "integer",
  };
  const form: ItemOf<"user_question"> = {
    id: "q",
    kind: "user_question",
    status: "in_progress",
    requestId: "req-form",
    mcpServer: "deploy",
    questions: [replicas],
  };

  afterEach(() => vi.restoreAllMocks());

  it("checks a number as it is typed and only sends one that fits", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<QuestionCard item={form} sessionId="s1" />, client);
    const input = screen.getByPlaceholderText("Type a whole number…");
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "five" } });
    expect(screen.getByText("Enter a whole number, like 3 or 1,000")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "1,000" } });
    expect(screen.queryByText(/Enter a whole number/)).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    fireEvent.click(send);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-form", {
        kind: "answer",
        answers: { replicas: ["1,000"] },
      }),
    );
  });

  it("leaves the agent's own free-text questions unchecked", () => {
    renderWithClient(
      <QuestionCard
        item={{ ...form, mcpServer: undefined, questions: [{ ...replicas, format: undefined }] }}
        sessionId="s1"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/your own answer/), { target: { value: "five" } });
    expect(screen.queryByText(/Enter a/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says a dismissed or declined form sent nothing, without marking it answered", () => {
    const { unmount } = renderWithClient(
      <QuestionCard item={{ ...form, status: "cancelled" }} sessionId="s1" />,
    );
    expect(screen.getByText("Dismissed: nothing was sent to deploy")).toBeTruthy();
    unmount();
    renderWithClient(
      <QuestionCard
        item={{
          ...form,
          status: "declined",
          questions: [
            {
              id: "confirm",
              question: "deploy asks: Deploy now?",
              options: [{ label: "Accept" }, { label: "Decline" }],
              multiSelect: false,
              allowFreeText: false,
            },
          ],
          answers: { confirm: ["Decline"] },
        }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Declined: deploy got no data")).toBeTruthy();
    expect(screen.queryByText(/Dismissed/)).toBeNull();
  });
});
