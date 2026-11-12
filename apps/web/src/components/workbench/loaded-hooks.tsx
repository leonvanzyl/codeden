import type { LoadedHooks } from "@codeden/contracts";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { hookSummary } from "@/components/agents/hook-form";

/** One row of a What's loaded list. */
export interface LoadedRow {
  key: string;
  label: string;
  detail?: string;
  /** A second, muted line (what a hook runs). */
  sub?: string;
  title?: string;
  /** Listed but not in effect (hooks while `disableAllHooks` is on). */
  dim?: boolean;
}

/** Hooks as rows: event and matcher, scope, and what each one runs; the file is the tooltip. */
export function hookRows(loaded: LoadedHooks): LoadedRow[] {
  const off = loaded.disabledBy !== null;
  return loaded.hooks.map((h, i) => ({
    key: `${h.file}:${h.event}:${h.groupIndex ?? i}:${h.handlerIndex ?? i}`,
    label: h.matcher ? `${h.event} · ${h.matcher}` : h.event,
    detail: h.scope,
    sub:
      h.handler.type === "command"
        ? hookSummary(h.handler)
        : `${h.handler.type}: ${hookSummary(h.handler)}`,
    title: `${h.file}${off ? "\nNot running: disableAllHooks is on" : ""}`,
    dim: off,
  }));
}

/**
 * What to know before reading the list: hooks are off for the session (`disabledBy`), a file
 * sets `disableAllHooks` but a higher-precedence file turns hooks back on, or a file can't be read.
 */
export function hookNotices(loaded: LoadedHooks): ReactNode {
  const items: Array<{ key: string; tone: "warn" | "error"; text: ReactNode }> = [];
  if (loaded.disabledBy) {
    items.push({
      key: "off",
      tone: "warn",
      text: (
        <>
          Hooks are off for this session: <Path file={loaded.disabledBy} /> sets disableAllHooks.
        </>
      ),
    });
  }
  for (const s of loaded.sources) {
    if (s.error) {
      items.push({ key: `error:${s.file}`, tone: "error", text: s.error });
    } else if (s.disableAllHooks && !loaded.disabledBy) {
      items.push({
        key: `overridden:${s.file}`,
        tone: "warn",
        text: (
          <>
            <Path file={s.file} /> sets disableAllHooks, but a file with higher precedence sets it
            to false, so hooks run.
          </>
        ),
      });
    }
  }
  if (items.length === 0) return null;
  return (
    <div className="space-y-1 border-b border-border px-3 py-1.5">
      {items.map((n) => (
        <p
          key={n.key}
          className={`flex gap-1.5 text-3xs ${n.tone === "error" ? "text-status-failed" : "text-status-waiting"}`}
        >
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{n.text}</span>
        </p>
      ))}
    </div>
  );
}

function Path({ file }: { file: string }) {
  return (
    <span className="font-mono" title={file}>
      {file}
    </span>
  );
}
