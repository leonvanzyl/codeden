import type { OpenTerminalOptions, TerminalChannel } from "../types";

const c = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const loginScript: Record<string, string[]> = {
  "codex login": [
    `${c.dim}Starting local login server on http://localhost:1455${c.reset}`,
    "If your browser did not open, navigate to this URL to authenticate:",
    `${c.cyan}https://auth.openai.com/oauth/authorize?client_id=…${c.reset}`,
    "",
    `${c.green}✓ Successfully logged in${c.reset}`,
  ],
  "opencode auth login": [
    `${c.dim}Select a provider to connect${c.reset}`,
    `${c.cyan}› Anthropic${c.reset}`,
    "Opening browser to sign in…",
    `${c.green}✓ Connected Anthropic${c.reset}`,
  ],
  "claude auth login": [
    "Opening browser to sign in…",
    `${c.green}✓ Logged in as leon@example.com${c.reset}`,
  ],
  "gh auth login": [
    `${c.yellow}!${c.reset} First copy your one-time code: ${c.bold}4F2A-91C7${c.reset}`,
    "Press Enter to open github.com in your browser…",
    `${c.green}✓ Authentication complete.${c.reset}`,
    `${c.green}✓ Logged in as leon${c.reset}`,
  ],
};

/** A small fake shell: prompt, echo, and canned output for a few commands. */
export function mockTerminal(opts: OpenTerminalOptions): TerminalChannel {
  const listeners = new Set<(d: string) => void>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cwd = opts.sessionId ? "~/.codeden/wt/storefront/fix-checkout-flake" : "~";
  const prompt = `${c.green}➜${c.reset} ${c.cyan}${cwd}${c.reset} ${c.dim}(codeden/fix-checkout-flake)${c.reset} $ `;
  const emit = (d: string) => {
    for (const l of listeners) l(d);
  };
  let line = "";

  const run = (cmdText: string) => {
    const script = loginScript[cmdText.trim()];
    const lines =
      script ??
      (cmdText.trim() === "git status"
        ? ["On branch codeden/fix-checkout-flake", "nothing to commit, working tree clean"]
        : cmdText.trim() === ""
          ? []
          : [`${c.dim}(mock shell) ran: ${cmdText}${c.reset}`]);
    lines.forEach((l, i) => {
      timers.push(setTimeout(() => emit(`${l}\r\n`), 250 + i * (script ? 700 : 60)));
    });
    timers.push(setTimeout(() => emit(prompt), 300 + lines.length * (script ? 700 : 60)));
  };

  timers.push(
    setTimeout(() => {
      emit(`${c.dim}CodeDen terminal · PowerShell 7.5 · runner-local${c.reset}\r\n`);
      if (opts.command) {
        emit(`${prompt}${opts.command}\r\n`);
        run(opts.command);
      } else emit(prompt);
    }, 50),
  );

  return {
    write(data) {
      for (const ch of data) {
        if (ch === "\r") {
          emit("\r\n");
          run(line);
          line = "";
        } else if (ch === "\x7f") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            emit("\b \b");
          }
        } else if (ch >= " ") {
          line += ch;
          emit(ch);
        }
      }
    },
    resize() {},
    onData(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onEvent(listener) {
      const t = setTimeout(() => listener({ type: "opened", ptyId: "pty-mock", attached: false }));
      timers.push(t);
      return () => clearTimeout(t);
    },
    close() {
      for (const t of timers) clearTimeout(t);
      listeners.clear();
    },
    kill() {
      for (const t of timers) clearTimeout(t);
      listeners.clear();
    },
  };
}
