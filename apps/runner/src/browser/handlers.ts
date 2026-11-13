import type {
  RunnerCommand,
  RunnerCommandName,
  RunnerCommandOf,
  RunnerCommandResult,
} from "@codeden/contracts";
import * as agent from "./agent";
import type { BrowserManager } from "./manager";
import * as pointer from "./pointer";

export type BrowserCommandName = Extract<RunnerCommandName, `browser.${string}`>;
export type BrowserCommand = RunnerCommandOf<BrowserCommandName>;

type Handlers = {
  [N in BrowserCommandName]: (command: RunnerCommandOf<N>) => Promise<RunnerCommandResult<N>>;
};

export interface BrowserCommandDeps {
  manager: BrowserManager;
}

/** True for `browser.*` runner commands. */
export function isBrowserCommand(command: RunnerCommand): command is BrowserCommand {
  return command.name.startsWith("browser.");
}

export interface BrowserCommandHandlers {
  handlers: Handlers;
  /** Execute any `browser.*` command. */
  execute(command: BrowserCommand): Promise<RunnerCommandResult<BrowserCommandName>>;
  /** Close a session's context if it has one (session stopped). Never throws. */
  closeSession(sessionId: string): Promise<void>;
}

/**
 * Handlers for the `browser.*` runner commands (§4.3, §12.2). Wire `execute` into the
 * runner's command switch for every command where `isBrowserCommand` is true.
 */
export function createBrowserCommandHandlers(deps: BrowserCommandDeps): BrowserCommandHandlers {
  const { manager } = deps;
  const handlers: Handlers = {
    "browser.open": async (c) => {
      const session = await manager.open(c.sessionId, c.url, c.relay);
      const native = session.engine === "native";
      return {
        cdpUrl: native ? null : manager.cdpUrl,
        tabs: session.listTabs(),
        engine: session.engine,
      };
    },
    "browser.handoff": async (c) => {
      const session = await manager.handoff(c.sessionId, c.tabs, c.cookies);
      return { tabs: session.listTabs() };
    },
    "browser.navigate": (c) => manager.get(c.sessionId).navigate(c.url, c.tabId),
    "browser.close": async (c) => {
      await manager.closeSession(c.sessionId);
      return {};
    },
    "browser.history": async (c) => ({
      url: await manager.get(c.sessionId).history(c.action, c.tabId),
    }),
    "browser.tabs.list": async (c) => {
      const session = manager.get(c.sessionId);
      return { tabs: session.listTabs(), engine: session.engine };
    },
    "browser.tabs.open": async (c) => ({ tab: await manager.get(c.sessionId).openTab(c.url) }),
    "browser.tabs.close": async (c) => {
      await manager.get(c.sessionId).closeTab(c.tabId);
      return {};
    },
    "browser.tabs.activate": async (c) => {
      await manager.get(c.sessionId).activate(c.tabId);
      return {};
    },
    "browser.viewport": async (c) => {
      const applied = await manager.setViewport(c.sessionId, {
        width: c.width,
        height: c.height,
        deviceScaleFactor: c.deviceScaleFactor,
      });
      // Native views follow the desktop panel: viewers fit the frames instead.
      return manager.get(c.sessionId).engine === "native" ? { ...applied, fixed: true } : applied;
    },
    "browser.screencast": async (c) => {
      const { quality, maxWidth, maxHeight, maxFps } = c;
      const session = manager.get(c.sessionId);
      if (c.watching) await session.syncViewport();
      const viewers = await session.screencast.watch(c.viewerId, c.watching, {
        quality,
        maxWidth,
        maxHeight,
        maxFps,
      });
      return { viewers };
    },
    "browser.input": async (c) => {
      await manager.get(c.sessionId).dispatchInput(c.input);
      return {};
    },
    "browser.devServer": async (c) => ({
      tab: await manager.openDevServer(c.sessionId, c.port, c.path),
    }),
    "browser.snapshot": (c) => agent.snapshot(manager.get(c.sessionId), c.tabId),
    "browser.click": async (c) => {
      const opts = { tabId: c.tabId, button: c.button, doubleClick: c.doubleClick };
      await agent.click(manager.get(c.sessionId), c.ref, opts);
      return {};
    },
    "browser.type": async (c) => {
      const opts = { tabId: c.tabId, submit: c.submit };
      await agent.type(manager.get(c.sessionId), c.ref, c.text, opts);
      return {};
    },
    "browser.press": async (c) => {
      await agent.press(manager.get(c.sessionId), c.key, c.tabId);
      return {};
    },
    "browser.mouse": async ({ name: _name, sessionId, ...command }) => {
      await pointer.mouse(manager.get(sessionId), command);
      return {};
    },
    "browser.screenshot": (c) =>
      agent.screenshot(manager.get(c.sessionId), c.path, {
        tabId: c.tabId,
        fullPage: c.fullPage,
        ref: c.ref,
      }),
    "browser.logs": async (c) => {
      const { logs } = manager.get(c.sessionId);
      const kind = c.kind ?? "all";
      const query = { tabId: c.tabId, since: c.since, limit: c.limit };
      return {
        console: kind === "network" ? [] : logs.consoleEntries(query),
        network: kind === "console" ? [] : logs.networkEntries(query),
      };
    },
    "browser.evaluate": (c) =>
      agent.evaluate(manager.get(c.sessionId), c.expression, manager.evaluateGuard, c.tabId),
    "browser.wait": async (c) => ({ matched: await agent.wait(manager.get(c.sessionId), c) }),
  };

  return {
    handlers,
    execute(command) {
      const handler = handlers[command.name] as (c: BrowserCommand) => Promise<never>;
      return handler(command);
    },
    async closeSession(sessionId) {
      if (manager.has(sessionId)) await manager.closeSession(sessionId).catch(() => undefined);
    },
  };
}
