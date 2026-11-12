import { type Item, type ItemRecord, messageFrom } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { draftFromSession, draftProblems, openingPrompt } from "@/components/automations/draft";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { canMakeAutomation } from "@/lib/session-actions";
import { NewAutomationPage } from "@/routes/automation-new";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const session = makeSession({
  id: "s-audit",
  projectId: "p-storefront",
  role: "agent",
  status: "idle",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  autonomy: "read_only",
  purpose: "Audit the auth routes",
  title: "Auth route audit",
  workKey: "session:auth-audit",
});
const root = session.rootThreadId ?? "";

const record = (position: number, item: Item, threadId = root): ItemRecord => ({
  sessionId: session.id,
  threadId,
  turnId: `turn-${position}`,
  position,
  item,
  createdAt: "2026-11-12T08:00:00.000Z",
  updatedAt: "2026-11-12T08:00:00.000Z",
});
const user = (id: string, text: string): Item => ({
  id,
  kind: "user_message",
  status: "completed",
  input: { text, attachments: [] },
});

describe("draftFromSession", () => {
  it("takes the root thread's first message, its agent and permissions, run by hand", () => {
    const items = [
      record(4, user("u2", "Now fix the first finding.")),
      record(0, user("sub", "Subagent: list the routes"), "t-child"),
      record(2, {
        id: "a1",
        kind: "assistant_message",
        status: "completed",
        text: "Found three issues.",
      }),
      record(1, {
        id: "u1",
        kind: "user_message",
        status: "completed",
        input: {
          text: "Audit the auth routes and open an issue per finding.",
          attachments: [{ type: "file", path: "notes/auth.md" }],
        },
      }),
    ];
    const draft = draftFromSession(session, items);
    expect(draft).toEqual({
      name: "Auth route audit",
      description: null,
      target: "project",
      trigger: { type: "manual" },
      action: {
        type: "start_session",
        prompt: "Audit the auth routes and open an issue per finding.",
        title: "Auth route audit",
        provider: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        autonomy: "read_only",
      },
      guards: {
        overlapPolicy: "skip-if-running",
        maxConcurrent: 1,
        maxPerDay: null,
        quietHours: null,
        catchUpMissed: false,
      },
    });
    expect(draftProblems(draft, "UTC")).toEqual([]);
  });

  it("drops the line naming a PM sender and keeps the brief", () => {
    const brief: Item = {
      id: "u1",
      kind: "user_message",
      status: "completed",
      input: messageFrom("pm", "Update the dependencies and open a PR."),
    };
    expect(openingPrompt(session, [record(0, brief)])).toBe(
      "Update the dependencies and open a PR.",
    );
  });

  it("falls back to the purpose, leaves out an unset model and effort, and an empty prompt", () => {
    const bare = { ...session, title: null, model: null, effort: null };
    const draft = draftFromSession(bare, []);
    expect(draft.name).toBe("Audit the auth routes");
    expect(draft.action).toEqual({
      type: "start_session",
      prompt: "",
      title: "Audit the auth routes",
      provider: "claude",
      autonomy: "read_only",
    });
    expect(draftProblems(draft, "UTC")).toEqual(["Write the prompt."]);
  });

  it("is offered for agent sessions in a project only", () => {
    expect(canMakeAutomation(session)).toBe(true);
    expect(canMakeAutomation({ role: "pm", projectId: "p-storefront" })).toBe(false);
    expect(canMakeAutomation({ role: "orchestrator", projectId: null })).toBe(false);
    expect(canMakeAutomation({ role: "agent", projectId: null })).toBe(false);
  });
});

describe("New automation from a session", () => {
  it("opens prefilled and saves nothing until Save, then saves it off", async () => {
    const client = createMockClient();
    const create = vi.spyOn(client.automations, "create");
    renderWithClient(<NewAutomationPage projectId="p-storefront" sessionId="s-search" />, client, {
      withRouter: true,
    });
    // The name and, under Advanced options, the session title.
    expect(await screen.findAllByDisplayValue("Add product search with filters")).toHaveLength(2);
    expect(screen.getByText("New from Add product search with filters")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const request = create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      projectId: "p-storefront",
      name: "Add product search with filters",
      trigger: { type: "manual" },
      enabled: false,
      action: {
        type: "start_session",
        provider: "codex",
        model: "default",
        effort: "medium",
        autonomy: "full",
      },
    });
    const action = request?.action;
    expect(action?.type === "start_session" && action.prompt).toMatch(
      /^Implement #139: product search/,
    );
  });

  it("falls back to a blank editor when the session can't be read", async () => {
    toast.error.mockClear();
    renderWithClient(<NewAutomationPage projectId="p-storefront" sessionId="s-gone" />, undefined, {
      withRouter: true,
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]?.[0]).toBe("Couldn't read that session");
    expect(await screen.findByText("New automation")).toBeTruthy();
    expect(screen.getByPlaceholderText("Weekly dependency check")).toHaveProperty("value", "");
  });
});
