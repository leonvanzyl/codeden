import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formToHandler } from "@/components/agents/hook-form";
import { HooksList } from "@/components/agents/hooks-list";
import { McpServers } from "@/components/agents/mcp-servers";
import { PatchView } from "@/components/agents/patch-dialog";
import { LoadedConfig } from "@/components/workbench/loaded-config";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

describe("McpServers", () => {
  it("lists servers and removes one after a diff preview", async () => {
    const client = createMockClient();
    const diffMcp = vi.spyOn(client.agentConfig, "diffMcp");
    const removeMcp = vi.spyOn(client.agentConfig, "removeMcp");
    renderWithClient(<McpServers projectId="p-storefront" />, client);
    expect(await screen.findByText("playwright")).toBeTruthy();
    // CodeDen's own server is read-only.
    expect(screen.queryByRole("button", { name: "Remove codeden" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove linear" }));
    await waitFor(() =>
      expect(diffMcp).toHaveBeenCalledWith({ provider: "claude", scope: "user", name: "linear" }),
    );
    const confirm = (await screen.findByRole("button", {
      name: "Remove server",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(screen.getByTestId("patch-view").textContent).toContain("-");
    fireEvent.click(confirm);
    await waitFor(() => expect(removeMcp).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("linear")).toBeNull());
  });
});

describe("HooksList", () => {
  it("lists hooks by settings file and disables one after a diff preview", async () => {
    const client = createMockClient();
    const diffHook = vi.spyOn(client.agentConfig, "diffHook");
    const changeHook = vi.spyOn(client.agentConfig, "changeHook");
    renderWithClient(<HooksList projectId="p-storefront" />, client);
    expect(await screen.findByText("~/.claude/hooks/block-rm-rf.sh")).toBeTruthy();
    expect(screen.getByText("pnpm biome format --write")).toBeTruthy();
    expect(screen.getByText("Local (private)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disable PreToolUse Bash" }));
    await waitFor(() =>
      expect(diffHook).toHaveBeenCalledWith(expect.objectContaining({ action: "disable" })),
    );
    const confirm = (await screen.findByRole("button", {
      name: "Disable hook",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(changeHook).toHaveBeenCalled());
    // The change asks for this page's list back and shows it without another request.
    expect(changeHook).toHaveBeenCalledWith(
      expect.objectContaining({ action: "disable", listProjectId: "p-storefront" }),
    );
    expect(await screen.findByText("disabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable PreToolUse Bash" })).toBeTruthy();
  });

  it("shows a file's disableAllHooks notice even when no hooks are listed", async () => {
    const client = createMockClient();
    vi.spyOn(client.agentConfig, "listHooks").mockResolvedValue({
      sources: [
        {
          provider: "claude",
          scope: "user",
          projectId: null,
          file: "C:\\Users\\you\\.claude\\settings.json",
          exists: true,
          disableAllHooks: true,
        },
      ],
      hooks: [],
    });
    renderWithClient(<HooksList projectId={null} />, client);
    expect(await screen.findByText("No hooks configured")).toBeTruthy();
    expect(screen.getByText(/This file sets disableAllHooks/)).toBeTruthy();
    expect(screen.getByText("C:\\Users\\you\\.claude\\settings.json")).toBeTruthy();
  });

  it("keeps a handler's other fields when it is edited", () => {
    const previous = {
      type: "command",
      command: "a.sh",
      if: "Bash(git *)",
      async: true,
      timeout: 5,
      custom: { keep: true },
    };
    const form = {
      event: "PreToolUse",
      matcher: "Bash",
      type: "command" as const,
      value: "b.sh",
      timeout: "",
    };
    const edited = formToHandler(form, previous);
    expect(edited).toEqual({
      type: "command",
      command: "b.sh",
      if: "Bash(git *)",
      async: true,
      custom: { keep: true },
    });
    expect(Object.keys(formToHandler({ ...form, timeout: "9" }, previous))).toEqual(
      Object.keys(previous),
    );
    // A new type drops only the old type's own fields (`command`, `async`); the rest stays.
    expect(formToHandler({ ...form, type: "prompt", value: "Safe?" }, previous)).toEqual({
      type: "prompt",
      prompt: "Safe?",
      if: "Bash(git *)",
      custom: { keep: true },
    });
    // Prompt and agent share `prompt` and `model`, so switching between them keeps both.
    const prompt = { type: "prompt", prompt: "Safe?", model: "haiku", statusMessage: "Checking" };
    expect(
      formToHandler({ ...form, type: "agent", value: "Safe?", timeout: "60" }, prompt),
    ).toEqual({
      type: "agent",
      prompt: "Safe?",
      model: "haiku",
      statusMessage: "Checking",
      timeout: 60,
    });
  });
});

describe("LoadedConfig", () => {
  it("shows memory, skills, subagents and MCP servers for a session", async () => {
    renderWithClient(<LoadedConfig sessionId="s1" projectId="p-storefront" />, createMockClient(), {
      withRouter: true,
    });
    expect(await screen.findByText("frontend-design")).toBeTruthy();
    expect(screen.getByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("CLAUDE.md")).toBeTruthy();
    expect(screen.getAllByText("built in").length).toBeGreaterThan(0);
  });
});

describe("PatchView", () => {
  it("renders every patch line", () => {
    renderWithClient(<PatchView patch={"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"} />);
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
  });
});
