import type {
  RunnerBackendId,
  RunnerCommand,
  RunnerCommandResult,
  RunnerEvent,
} from "@codeden/contracts";
import { FORK_POINT_MISSING, type ProviderRegistry, refreshProcessPath } from "@codeden/providers";
import type { BrowserCommandHandlers } from "./browser";
import { CommandError } from "./errors";
import {
  createCheckpoint,
  diffCheckpoints,
  listCheckpoints,
  restoreFiles,
} from "./git/checkpoints";
import * as gitOps from "./git/ops";
import type { Journal } from "./journal";
import { listPorts } from "./ports";
import type { ProcessSupervisor } from "./process/supervisor";
import type { TerminalHost } from "./pty/terminal-host";
import type { SessionHost } from "./session-host";
import { removeWithLeftovers, stopWithLeftovers } from "./workspace/leftover-processes";
import { prepareWorkspace } from "./workspace/worktree";

/** Everything command handlers need; owned by `startRunner`. */
export interface RunnerCore {
  home: string;
  /** Where this runner runs, reported in `welcome` (`docs/remote-runners.md` §5). */
  backend: RunnerBackendId;
  version: string;
  journal: Journal;
  host: SessionHost;
  terminals: TerminalHost;
  supervisor: ProcessSupervisor;
  registry: ProviderRegistry;
  /** `browser.*` handlers over the runner's `BrowserManager` (§12.2). */
  browser: BrowserCommandHandlers;
  startedAt: string;
  emit: (event: RunnerEvent) => void;
  /** The runner's log (background work such as emptying the worktree trash). */
  log?: (message: string) => void;
  isDraining: () => boolean;
  drain: (opts: { reason: string; timeoutMs?: number; exitWhenDrained?: boolean }) => void;
  /** Point the MCP proxy at an upstream; returns the agent-facing proxy URL. */
  configureMcp: (upstreamUrl: string | null) => string | null;
  /** Exit the process shortly after the current result is sent. */
  shutdown: () => void;
}

type AnyResult = RunnerCommandResult<RunnerCommand["name"]>;

/** Execute one server command (§4.3). Throws `CommandError` for expected failures. */
export async function executeCommand(core: RunnerCore, command: RunnerCommand): Promise<AnyResult> {
  const { host, journal, registry, terminals } = core;
  switch (command.name) {
    case "runner.status":
      return {
        sessions: host.list(),
        ptys: terminals.ids(),
        journal: { lastSeq: journal.lastSeq, unacked: journal.unacked },
        draining: core.isDraining(),
      };
    case "runner.drain":
      core.drain(command);
      return {};
    case "runner.configure":
      return { mcpProxyUrl: core.configureMcp(command.mcpUpstreamUrl) };
    case "runner.shutdown":
      core.shutdown();
      return {};
    case "provider.detect": {
      // A long-lived runner would otherwise keep the PATH it started with; tools installed
      // since then are found, and agents and terminals started afterwards see them too.
      const added = await refreshProcessPath();
      if (added.length > 0) core.log?.(`PATH: picked up ${added.join(", ")}`);
      const adapters = command.providerId
        ? registry.list().filter((a) => a.id === command.providerId)
        : registry.list();
      const statuses = await Promise.all(adapters.map((a) => a.detect()));
      // A periodic availability check (the factory) only wants to know who is signed in.
      if (command.refreshModels === false) return { statuses };
      // A re-detect (after an install or a login, or "Refresh models") also refreshes model
      // lists; changes reach the server as a `providers` message as well.
      const refreshed = registry.refreshModels(adapters.map((a) => a.id));
      if (!command.waitForModels) return { statuses };
      await refreshed;
      return { statuses, providers: registry.info() };
    }

    case "provider.oneShot": {
      const adapter = registry.get(command.providerId);
      const utility = adapter?.utilityModel?.();
      if (!utility) {
        throw new CommandError(
          "unsupported",
          `Provider ${command.providerId} has no utility model`,
        );
      }
      const model = command.model ?? utility.defaultModel;
      const text = await utility.runOneShot({
        prompt: command.prompt,
        system: command.system,
        model,
        timeoutMs: command.timeoutMs,
      });
      return { text, model };
    }
    case "provider.fork": {
      const adapter = registry.get(command.providerId);
      if (!adapter?.capabilities().fork || !adapter.forkConversation) {
        throw new CommandError("unsupported", `Provider ${command.providerId} cannot fork`);
      }
      try {
        const resumeToken = await adapter.forkConversation(command.resumeToken, {
          cwd: command.cwd,
          ...(command.upTo ? { upTo: command.upTo } : {}),
        });
        return { resumeToken };
      } catch (error) {
        // The conversation no longer holds the fork point: say so, apart from other failures.
        const missing = (error as { code?: unknown }).code === FORK_POINT_MISSING;
        throw new CommandError(
          missing ? FORK_POINT_MISSING : "fork_failed",
          (error as Error).message,
        );
      }
    }

    case "workspace.prepare":
      if (core.isDraining()) throw new CommandError("draining", "Runner is draining");
      return prepareWorkspace(command, {
        home: core.home,
        supervisor: core.supervisor,
        emit: core.emit,
      });
    case "workspace.remove":
      return removeWithLeftovers(command, {
        home: core.home,
        supervisor: core.supervisor,
        terminals,
        log: core.log,
      });

    case "session.start":
      if (core.isDraining()) throw new CommandError("draining", "Runner is draining");
      return host.start(command);
    case "session.send":
      await host.send(command);
      return {};
    case "session.steer":
      await host.steer(command);
      return {};
    case "session.interrupt":
      await host.interrupt(command.sessionId);
      return {};
    case "session.respond":
      await host.respond(command);
      return {};
    case "session.configure":
      await host.configure(command);
      return {};
    case "session.stop": {
      const ctx = { home: core.home, supervisor: core.supervisor, cwds: () => host.cwds() };
      await stopWithLeftovers({ ...ctx, log: core.log }, command.sessionId, async () => {
        await host.stop(command.sessionId);
        // The session's browser context (cookies, tabs) ends with the session.
        await core.browser.closeSession(command.sessionId);
      });
      return {};
    }

    case "pty.open":
      return terminals.open(command);
    case "pty.input":
      terminals.input(command.ptyId, command.data);
      return {};
    case "pty.resize":
      terminals.resize(command.ptyId, command.cols, command.rows);
      return {};
    case "pty.attach":
      return terminals.attach(command.ptyId);
    case "pty.close":
      await terminals.close(command.ptyId);
      return {};

    case "git.checkpoint": {
      const cp = await createCheckpoint(command.cwd, command.sessionId, command.index);
      const { index, ref, commit } = cp;
      core.emit({ kind: "checkpoint.created", sessionId: command.sessionId, index, ref, commit });
      return { ref: cp.ref, commit: cp.commit };
    }
    case "git.status":
      return gitOps.status(command.cwd);
    case "git.diff":
      return gitOps.diff(command);
    case "git.branches":
      return gitOps.branches(command);
    case "git.commit":
      return gitOps.commit(command);
    case "git.push":
      return gitOps.push(command);

    case "checkpoint.list":
      if (command.settled) await host.settled(command.sessionId);
      return { checkpoints: await listCheckpoints(command.cwd, command.sessionId) };
    case "checkpoint.diff":
      return diffCheckpoints(command.cwd, command.sessionId, command.from, command.to);
    case "checkpoint.restoreFiles":
      return restoreFiles(command.cwd, command.sessionId, command.index, command.paths);

    case "ports.list":
      return { ports: await listPorts(command.probe) };

    case "mcp.test": {
      // Loaded on first use: the MCP client adds about 300 ms to every runner start otherwise.
      const { testMcpServer } = await import("./mcp/server-test");
      return testMcpServer({
        spec: command.spec,
        cwd: command.cwd,
        expandEnv: command.expandEnv,
        stdioEnv: command.stdioEnv,
        timeoutMs: command.timeoutMs,
        clientVersion: core.version,
        supervisor: core.supervisor,
      });
    }

    default: {
      // Only `browser.*` commands reach here (checked by the type below).
      const browserCommand: Extract<RunnerCommand, { name: `browser.${string}` }> = command;
      return core.browser.execute(browserCommand);
    }
  }
}
