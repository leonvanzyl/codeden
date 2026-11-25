import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef } from "react";
import { useClient } from "@/lib/api";
import { terminalColors } from "@/lib/theme/terminal";
import { cn } from "@/lib/utils";
import { useCurrentTheme } from "@/stores/theme";

/** Terminals opened per slot (`<session>:<slot>`), re-attached when the view remounts. */
const attached = new Map<string, string>();

/**
 * xterm.js wired to a `TerminalChannel` from the client (§12.1). Session terminals live in the
 * runner, so unmounting only detaches and the next mount re-attaches with its scrollback.
 * `ephemeral` terminals (setup sign-in) are killed on unmount instead.
 */
export function TerminalView({
  sessionId,
  command,
  className,
  slot = "panel",
  ephemeral = false,
}: {
  sessionId: string | null;
  command?: string;
  className?: string;
  /** Distinguishes several terminals of one session (panel, drawer). */
  slot?: string;
  ephemeral?: boolean;
}) {
  const client = useClient();
  const current = useCurrentTheme();
  const colors = useMemo(() => terminalColors(current), [current]);
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: colours are applied separately below.
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 5000,
      theme: colors,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    const key = `${sessionId ?? "home"}:${slot}`;
    const ptyId = ephemeral ? undefined : attached.get(key);
    const channel = client.openTerminal({ sessionId, command, ptyId });
    const offData = channel.onData((d) => term.write(d));
    const offEvent = channel.onEvent((e) => {
      if (e.type === "opened" && !ephemeral) attached.set(key, e.ptyId);
      if (e.type === "exited") {
        attached.delete(key);
        term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      }
      if (e.type === "error") {
        if (ptyId) attached.delete(key);
        term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
      }
    });
    const offInput = term.onData((d) => channel.write(d));
    const resize = () => {
      try {
        fit.fit();
        channel.resize(term.cols, term.rows);
      } catch {
        // Hidden or zero-size container; ignore until visible.
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    return () => {
      observer.disconnect();
      offData();
      offEvent();
      offInput.dispose();
      if (ephemeral) channel.kill();
      else channel.close();
      term.dispose();
      termRef.current = null;
    };
  }, [client, sessionId, command, slot, ephemeral]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = colors;
  }, [colors]);

  return (
    <div className={cn("h-full p-2", className)} style={{ background: colors.background }}>
      <div ref={host} className="h-full w-full" data-testid="terminal" />
    </div>
  );
}
