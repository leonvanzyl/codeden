import type { ArchiveSessionResponse, Session } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionsList } from "@/components/project/lists";
import type { RowMenuAction, RowMenuEntry } from "@/components/shell/sidebar/row-menu";
import { sessionMenuEntries } from "@/components/shell/sidebar/session-menu";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import {
  canStop,
  type SessionActions,
  sessionLink,
  useSessionActions,
} from "@/lib/session-actions";
import { sessionCounts, sessionsInView } from "@/lib/session-filter";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const session = (id: string) => {
  const found = fixtureSessions.find((s) => s.id === id);
  if (!found) throw new Error(`no fixture session ${id}`);
  return found;
};

/** Renders the hook and reports its actions. */
function Probe({ target, onActions }: { target: Session; onActions: (a: SessionActions) => void }) {
  onActions(useSessionActions(target));
  return <span>ready</span>;
}

/** Render `useSessionActions` for a session and hand back the latest actions. */
async function actionsFor(target: Session, client = createMockClient()) {
  let latest: SessionActions | undefined;
  renderWithClient(
    <Probe
      target={target}
      onActions={(a) => {
        latest = a;
      }}
    />,
    client,
    { withRouter: true },
  );
  await screen.findByText("ready");
  if (!latest) throw new Error("not rendered");
  return { actions: latest, client };
}

const labels = (entries: RowMenuEntry[]) => entries.map((e) => (e === "separator" ? "—" : e.label));
const action = (entries: RowMenuEntry[], label: string) =>
  entries.find((e): e is RowMenuAction => e !== "separator" && e.label === label);

describe("useSessionActions", () => {
  it("archives with an Undo that unarchives", async () => {
    toast.success.mockClear();
    const { actions, client } = await actionsFor(session("s-search"));
    const archive = vi.spyOn(client, "archiveSession");
    const unarchive = vi.spyOn(client, "unarchiveSession");
    actions.archive();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(archive).toHaveBeenCalledWith("s-search", { force: false });
    const [message, options] = toast.success.mock.calls[0] ?? [];
    expect(message).toBe("Session archived and its worktree removed");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-search"));
  });

  it("says when uncommitted changes were discarded", async () => {
    toast.success.mockClear();
    const client = createMockClient();
    vi.spyOn(client, "archiveSession").mockResolvedValueOnce({
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "removed", message: "Its uncommitted changes were discarded" },
    });
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [message, options] = toast.success.mock.calls[0] ?? [];
    expect(message).toBe("Session archived and its worktree removed");
    expect(options.description).toBe("Its uncommitted changes were discarded");
  });

  it("offers Try again and Undo when the worktree couldn't be removed", async () => {
    toast.warning.mockClear();
    const client = createMockClient();
    const detail = `A file in the worktree is in use (${"node_modules/".repeat(20)}x.node).`;
    const failed: ArchiveSessionResponse = {
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "failed", message: detail },
    };
    const archive = vi
      .spyOn(client, "archiveSession")
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ ...failed, worktree: { status: "removed", message: null } });
    const unarchive = vi.spyOn(client, "unarchiveSession");
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [message, options] = toast.warning.mock.calls[0] ?? [];
    expect(message).toBe("Session archived, but its worktree couldn't be removed yet");
    expect(options.description.length).toBeLessThanOrEqual(160);
    expect(options.description).toMatch(/^A file in the worktree is in use/);
    expect(options.action.label).toBe("Try again");
    expect(options.cancel.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(archive).toHaveBeenLastCalledWith("s-deps", { force: false });
    options.cancel.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });

  it("offers Remove anyway and Undo when the worktree had changes", async () => {
    toast.mockClear();
    const client = createMockClient();
    const kept: ArchiveSessionResponse = {
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "kept_changes", message: null },
    };
    const archive = vi
      .spyOn(client, "archiveSession")
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce({ ...kept, worktree: { status: "removed", message: null } });
    const unarchive = vi.spyOn(client, "unarchiveSession");
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [, options] = toast.mock.calls[0] ?? [];
    expect(options.action.label).toBe("Remove anyway");
    expect(options.cancel.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith("s-deps", { force: true }));
    options.cancel.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });

  it("renames with a trimmed title and ignores blank or unchanged ones", async () => {
    const client = createMockClient();
    const update = vi.spyOn(client, "updateSession");
    const target = session("s-search");
    const { actions } = await actionsFor(target, client);
    actions.rename("   ");
    actions.rename(target.title ?? target.purpose);
    expect(update).not.toHaveBeenCalled();
    actions.rename("  Search v2  ");
    await waitFor(() => expect(update).toHaveBeenCalledWith("s-search", { title: "Search v2" }));
  });

  it("stops only sessions that are working or waiting", () => {
    expect(canStop({ status: "running" })).toBe(true);
    expect(canStop({ status: "waiting" })).toBe(true);
    expect(canStop({ status: "idle" })).toBe(false);
    expect(canStop({ status: "failed" })).toBe(false);
    expect(sessionLink("s 1", "http://127.0.0.1:4318")).toBe(
      "http://127.0.0.1:4318/sessions/s%201",
    );
  });
});

describe("session row menu", () => {
  const fake = (patch: Partial<SessionActions>): SessionActions => ({
    open: vi.fn(),
    rename: vi.fn(),
    copyLink: vi.fn(async () => {}),
    canMakeAutomation: true,
    makeAutomation: vi.fn(),
    canStop: false,
    stop: vi.fn(),
    archived: false,
    archive: vi.fn(),
    unarchive: vi.fn(),
    ...patch,
  });

  it("lists Open, Rename, Copy link, Stop while working, then Archive", () => {
    expect(labels(sessionMenuEntries(fake({ canStop: true }), vi.fn()))).toEqual([
      "Open",
      "Rename",
      "Copy link",
      "Stop",
      "—",
      "Archive",
    ]);
    expect(labels(sessionMenuEntries(fake({}), vi.fn()))).toEqual([
      "Open",
      "Rename",
      "Copy link",
      "—",
      "Archive",
    ]);
  });

  it("offers Unarchive for archived sessions and keeps focus for Rename", () => {
    const actions = fake({ archived: true });
    const rename = vi.fn();
    const entries = sessionMenuEntries(actions, rename);
    action(entries, "Unarchive")?.onSelect();
    expect(actions.unarchive).toHaveBeenCalled();
    expect(action(entries, "Archive")).toBeUndefined();
    expect(action(entries, "Rename")?.keepFocus).toBe(true);
    action(entries, "Rename")?.onSelect();
    expect(rename).toHaveBeenCalled();
  });
});

describe("archived sessions", () => {
  const archivedAt = "2026-11-08T08:00:00.000Z";
  const list = fixtureSessions.map((s) =>
    s.id === "s-deps" || s.id === "s-a11y" ? { ...s, archivedAt } : s,
  );

  it("splits a project's agent sessions into active and archived", () => {
    const active = sessionsInView(list, "p-storefront", "active");
    const archived = sessionsInView(list, "p-storefront", "archived");
    expect(archived.map((s) => s.id).sort()).toEqual(["s-a11y", "s-deps"]);
    expect(active.every((s) => !s.archivedAt && s.role === "agent")).toBe(true);
    expect(active.some((s) => s.id === "s-deps")).toBe(false);
    expect(sessionCounts(list, "p-storefront")).toEqual({
      active: active.length,
      archived: 2,
    });
    // Most recently updated first.
    const times = active.map((s) => Date.parse(s.updatedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("unarchives from the project's archived list", async () => {
    const client = createMockClient();
    const unarchive = vi.spyOn(client, "unarchiveSession");
    renderWithClient(
      <SessionsList sessions={sessionsInView(list, "p-storefront", "archived")} />,
      client,
      { withRouter: true },
    );
    const buttons = await screen.findAllByRole("button", { name: /^Unarchive / });
    expect(buttons).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Unarchive Dependency updates/ }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });
});
