import type { CSSProperties } from "react";
import type { ThemeKind } from "@/lib/theme/presets";
import { THEME_VARIABLES, type ThemeTokens } from "@/lib/theme/tokens";
import { cn } from "@/lib/utils";

/**
 * A theme's variables scoped to one element, so the usual classes (`bg-card`,
 * `text-muted-foreground`) inside it show that theme whatever the page uses (`index.css`
 * declares the colour utilities `inline`, so they read the variables where they're used).
 */
export function scopedTheme(tokens: ThemeTokens, kind: ThemeKind): CSSProperties {
  const vars: Record<string, string> = { colorScheme: kind };
  for (const v of THEME_VARIABLES) vars[`--${v}`] = tokens[v];
  return vars as CSSProperties;
}

/** A thumbnail of the app in a theme's colours, for the preset cards. */
export function ThemeSwatch({ tokens, kind }: { tokens: ThemeTokens; kind: ThemeKind }) {
  return (
    <div
      aria-hidden
      style={scopedTheme(tokens, kind)}
      className="flex h-[76px] overflow-hidden rounded-md border border-border bg-background"
    >
      <div className="flex w-[34%] flex-col gap-1.5 border-r border-sidebar-border bg-sidebar p-2">
        {(["running", "waiting", "done", "failed"] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <span className={cn("size-1.5 shrink-0 rounded-full", DOT[s])} />
            <span
              className={cn(
                "h-1 rounded-full",
                i === 0 ? "w-full bg-sidebar-foreground" : "w-3/4 bg-muted-foreground/70",
              )}
            />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="ml-auto h-2.5 w-3/5 rounded-sm bg-message" />
        <div className="h-1 w-11/12 rounded-full bg-foreground" />
        <div className="h-1 w-2/3 rounded-full bg-muted-foreground" />
        <div className="mt-auto flex items-center gap-1">
          <span className="h-3 w-8 rounded-sm bg-primary" />
          <span className="h-3 w-6 rounded-sm border border-input" />
          <span className="ml-auto h-1 w-3 rounded-full bg-diff-add" />
          <span className="h-1 w-3 rounded-full bg-diff-del" />
        </div>
      </div>
    </div>
  );
}

const DOT = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  done: "bg-status-done",
  failed: "bg-status-failed",
} as const;

const SESSIONS = [
  { title: "Fix the flaky upload test", status: "running" },
  { title: "Add CSV export", status: "waiting" },
  { title: "Refactor the auth module", status: "done" },
  { title: "Bump the parser", status: "failed" },
] as const;

/**
 * A larger, readable sample of the app in a theme: sidebar, a short thread, a diff, an input and
 * buttons, with real text so contrast can be judged by eye. Live: it re-renders as colours change.
 */
export function ThemePreview({ tokens, kind }: { tokens: ThemeTokens; kind: ThemeKind }) {
  return (
    <div
      style={scopedTheme(tokens, kind)}
      className="flex min-h-[300px] overflow-hidden rounded-lg border border-border bg-background text-foreground"
      data-testid="theme-preview"
    >
      <div className="hidden w-[38%] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 @[34rem]:flex">
        <div className="px-1.5 pb-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          Sessions
        </div>
        {SESSIONS.map((s, i) => (
          <div
            key={s.title}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-sidebar-foreground",
              i === 0 && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", DOT[s.status])} />
            <span className="truncate">{s.title}</span>
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3 text-xs">
        <div className="ml-auto max-w-[85%] rounded-lg bg-message px-2.5 py-1.5">
          Make the upload test deterministic.
        </div>
        <div className="leading-relaxed">
          Found it: the test waits on a real timer. See{" "}
          <span className="text-primary underline underline-offset-2">upload.test.ts</span>.
          <div className="mt-0.5 text-2xs text-muted-foreground">Ran 3 commands · 12 s</div>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-surface font-mono text-2xs">
          <div className="border-b border-border bg-card px-2 py-1 text-muted-foreground">
            upload.test.ts <span className="text-diff-add">+2</span>{" "}
            <span className="text-diff-del">−1</span>
          </div>
          <div className="px-2 py-0.5 text-diff-del">- await sleep(500);</div>
          <div className="px-2 py-0.5 text-diff-add">+ vi.useFakeTimers();</div>
          <div className="px-2 py-0.5 text-diff-add">+ await vi.runAllTimersAsync();</div>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <span className="min-w-24 flex-1 rounded-md border border-input bg-background px-2 py-1 text-muted-foreground">
            Ask a follow-up…
          </span>
          <span className="rounded-md bg-secondary px-2 py-1 text-secondary-foreground">
            Review
          </span>
          <span className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground">
            Send
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
          {(["running", "waiting", "done", "failed"] as const).map((s) => (
            <span key={s} className={cn("capitalize", TEXT[s])}>
              {s}
            </span>
          ))}
          <span className="text-destructive">Delete branch</span>
        </div>
      </div>
    </div>
  );
}

const TEXT = {
  running: "text-status-running",
  waiting: "text-status-waiting",
  done: "text-status-done",
  failed: "text-status-failed",
} as const;
