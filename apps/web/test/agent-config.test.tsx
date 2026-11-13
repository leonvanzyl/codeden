import type { AgentConfigScope, LoadedHooks } from "@codeden/contracts";
import { EditorView } from "@codemirror/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formToHandler } from "@/components/agents/hook-form";
import { HooksList } from "@/components/agents/hooks-list";
import { McpServers } from "@/components/agents/mcp-servers";
import { MemoryEditor, SkillsView } from "@/components/agents/memory-editor";
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

describe("SkillsView", () => {
  it("switches a skill off after a diff preview and shows it as off", async () => {
    const client = createMockClient();
    const diffSkillSwitch = vi.spyOn(client.agentConfig, "diffSkillSwitch");
    const switchSkill = vi.spyOn(client.agentConfig, "switchSkill");
    const { queryClient } = renderWithClient(<SkillsView projectId="p-storefront" />, client, {
      withRouter: true,
    });
    // A session's `/` menu cached before the switch (the composer keeps it for a minute).
    const menu = ["commands", "s-checkout"];
    queryClient.setQueryData(menu, [
      { name: "playwright-e2e", description: "", kind: "skill", provider: "claude" },
    ]);
    const toggle = await screen.findByRole("switch", { name: "playwright-e2e: on" });
    // A partial Claude state shows its native name; the skill stays switched on.
    expect(screen.getByText("name-only")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "frontend-design: on" })).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(diffSkillSwitch).toHaveBeenCalledWith({
        root: "project",
        projectId: "p-storefront",
        path: ".claude/skills/playwright-e2e/SKILL.md",
        provider: "claude",
        enabled: false,
        listProjectId: "p-storefront",
      }),
    );
    expect(await screen.findByText(/applies in every project/)).toBeTruthy();
    const confirm = (await screen.findByRole("button", {
      name: "Switch off",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(screen.getByTestId("patch-view").textContent).toContain('"playwright-e2e": "off"');
    fireEvent.click(confirm);
    await waitFor(() => expect(switchSkill).toHaveBeenCalled());
    expect(await screen.findByRole("switch", { name: "playwright-e2e: off" })).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
    const row = screen.getByText("playwright-e2e").closest("[data-muted]");
    expect(row?.getAttribute("data-muted")).toBe("true");
    // The cached menu is marked stale, so the composer asks again before offering the skill.
    expect(queryClient.getQueryState(menu)?.isInvalidated).toBe(true);
  });
});

describe("ConfigFilesView on a phone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a file in the list's place and keeps its draft across Back", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 767.98px)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    renderWithClient(<MemoryEditor projectId="p-storefront" />, createMockClient());
    const rowName = /^\.claude\/rules\/testing\.md/;
    // The list comes first: no file is open.
    const row = await screen.findByRole("button", { name: rowName });
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
    fireEvent.click(row);
    const back = await screen.findByRole("button", { name: "Back to files" });
    expect(screen.queryByRole("button", { name: rowName })).toBeNull();

    // Edit the open file, go back to the list and open it again: the draft is still there.
    const editor = screen.getByTestId("config-file-editor");
    await waitFor(() => expect(editor.querySelector(".cm-editor")).toBeTruthy());
    const view = EditorView.findFromDOM(editor.querySelector(".cm-editor") as HTMLElement);
    view?.dispatch({ changes: { from: 0, insert: "- Run the tests first.\n" } });
    const save = screen.getByRole("button", { name: "Review & save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(back);
    expect(screen.queryByRole("button", { name: "Review & save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: rowName }));
    expect(
      (screen.getByRole("button", { name: "Review & save" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("LoadedConfig", () => {
  it("marks skills that are switched off for the session", async () => {
    const client = createMockClient();
    const base = await client.agentConfig.loaded("s1");
    const [first, ...rest] = base.skills;
    if (!first) throw new Error("the mock world has skills");
    vi.spyOn(client.agentConfig, "loaded").mockResolvedValue({
      ...base,
      skills: [{ ...first, enabled: false, visibility: undefined }, ...rest],
    });
    renderWithClient(<LoadedConfig sessionId="s1" projectId="p-storefront" />, client, {
      withRouter: true,
    });
    const skills = within(await screen.findByTestId("loaded-skills"));
    expect(await skills.findByText(`${first.scope} · off`)).toBeTruthy();
    const link = skills.getByRole("link", { name: "Switch skills" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("tab=skills");
  });

  it("shows memory, skills, subagents and MCP servers for a session", async () => {
    renderWithClient(<LoadedConfig sessionId="s1" projectId="p-storefront" />, createMockClient(), {
      withRouter: true,
    });
    expect(await screen.findByText("frontend-design")).toBeTruthy();
    expect(screen.getByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("CLAUDE.md")).toBeTruthy();
    expect(screen.getAllByText("built in").length).toBeGreaterThan(0);
    // Hooks that apply: event and matcher, what runs, and a link to the Hooks tab.
    const hooks = within(screen.getByTestId("loaded-hooks"));
    expect(hooks.getByText("PreToolUse · Bash")).toBeTruthy();
    expect(hooks.getByText("~/.claude/hooks/block-rm-rf.sh")).toBeTruthy();
    expect(hooks.getByText("prompt: Did the agent run the tests?")).toBeTruthy();
    // A group without a matcher matches everything.
    expect(hooks.getByText("Notification · all")).toBeTruthy();
    expect(hooks.getByText("Stop · all")).toBeTruthy();
    const edit = hooks.getByRole("link", { name: "Edit hooks" }) as HTMLAnchorElement;
    expect(edit.getAttribute("href")).toContain("tab=hooks");
    expect(edit.getAttribute("href")).toContain("project=p-storefront");
  });

  describe("disableAllHooks and matchers", () => {
    const user = "C:\\Users\\you\\.claude\\settings.json";
    const project = "C:\\Code\\storefront\\.claude\\settings.json";
    const local = "C:\\Code\\storefront\\.claude\\settings.local.json";
    const source = (scope: AgentConfigScope, file: string, disableAllHooks: boolean) => ({
      provider: "claude" as const,
      scope,
      projectId: scope === "user" ? null : "p-storefront",
      file,
      exists: true,
      disableAllHooks,
    });
    const hook = (file: string, event: string, matcher: string | null, command: string) => ({
      ...source("local", file, false),
      event,
      matcher,
      handler: { type: "command", command },
      enabled: true,
      groupIndex: 0,
      handlerIndex: 0,
    });
    /** Render What's loaded with these hooks; returns the hooks list and its notices. */
    async function renderHooks(hooks: LoadedHooks) {
      const client = createMockClient();
      const base = await client.agentConfig.loaded("s1");
      vi.spyOn(client.agentConfig, "loaded").mockResolvedValue({ ...base, hooks });
      renderWithClient(<LoadedConfig sessionId="s1" projectId={null} />, client, {
        withRouter: true,
      });
      const list = within(await screen.findByTestId("loaded-hooks"));
      const notices = list.queryAllByText(/disableAllHooks/).map((n) => n.textContent);
      return { list, notices };
    }

    it("shows a missing or empty matcher as all", async () => {
      const { list } = await renderHooks({
        sources: [source("local", local, false)],
        hooks: [
          hook(local, "PreToolUse", "", "./guard.sh"),
          hook(local, "PostToolUse", null, "./format.sh"),
          hook(local, "PostToolUse", "Edit|Write", "./lint.sh"),
        ],
        disabledBy: null,
      });
      expect(list.getByText("PreToolUse · all")).toBeTruthy();
      expect(list.getByText("PostToolUse · all")).toBeTruthy();
      expect(list.getByText("PostToolUse · Edit|Write")).toBeTruthy();
    });

    it("names the file that turns hooks off and flags every other file that sets it", async () => {
      const { notices } = await renderHooks({
        sources: [
          source("user", user, true),
          source("project", project, false),
          source("local", local, true),
        ],
        hooks: [hook(local, "PreToolUse", "Bash", "./guard.sh")],
        disabledBy: local,
      });
      expect(notices).toEqual([
        `Hooks are off for this session: ${local} sets disableAllHooks.`,
        `${user} also sets disableAllHooks.`,
      ]);
    });

    it("says when a higher-precedence false overrides a file's true", async () => {
      const { list, notices } = await renderHooks({
        sources: [source("user", user, true), source("project", project, false)],
        hooks: [hook(project, "Stop", null, "notify")],
        disabledBy: null,
      });
      expect(notices).toEqual([
        `${user} sets disableAllHooks, but a file with higher precedence sets it to false, so hooks run.`,
      ]);
      expect(list.queryByText(/Hooks are off/)).toBeNull();
    });
  });

  it("hides hooks for providers without them", async () => {
    const client = createMockClient();
    const base = await client.agentConfig.loaded("s1");
    const loaded = vi.spyOn(client.agentConfig, "loaded");
    loaded.mockResolvedValueOnce({ ...base, provider: "codex", hooks: null });
    renderWithClient(<LoadedConfig sessionId="s2" projectId={null} />, client, {
      withRouter: true,
    });
    expect(await screen.findByText("frontend-design")).toBeTruthy();
    expect(screen.queryByTestId("loaded-hooks")).toBeNull();
  });
});

describe("PatchView", () => {
  it("renders every patch line", () => {
    renderWithClient(<PatchView patch={"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"} />);
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
  });
});
