import type { ThemeTokenKey } from "@codeden/contracts";

/**
 * The colour variables a theme sets: the same names `index.css` declares in `:root` (light) and
 * `.dark`. A theme other than CodeDen's own two sets all of them on `<html>`.
 */
export const THEME_VARIABLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "status-running",
  "status-waiting",
  "status-done",
  "status-failed",
  "status-idle",
  "panel",
  "glow",
  "message",
  "surface",
  "diff-add",
  "diff-del",
] as const;

export type ThemeVariable = (typeof THEME_VARIABLES)[number];

/** Every colour of a theme, as CSS colour strings (`oklch()` or `#hex`). */
export type ThemeTokens = Record<ThemeVariable, string>;

/** The variable each customisable key edits directly (the rest follow, see `derive.ts`). */
export const KEY_VARIABLE: Record<ThemeTokenKey, ThemeVariable> = {
  background: "background",
  foreground: "foreground",
  mutedText: "muted-foreground",
  primary: "primary",
  border: "border",
  running: "status-running",
  waiting: "status-waiting",
  done: "status-done",
  failed: "status-failed",
};

/** Labels and help for the theme editor. */
export const KEY_LABELS: Record<ThemeTokenKey, { label: string; help: string }> = {
  background: { label: "Background", help: "The page; cards, sidebar and panels follow it." },
  foreground: { label: "Text", help: "Body text." },
  mutedText: { label: "Muted text", help: "Timestamps, help text, placeholders." },
  primary: { label: "Accent", help: "Buttons, links, focus ring and selection." },
  border: { label: "Border", help: "Dividers; input outlines follow it." },
  running: { label: "Running", help: "Working sessions." },
  waiting: { label: "Waiting", help: "Sessions that need you." },
  done: { label: "Done", help: "Finished sessions and added lines." },
  failed: { label: "Failed", help: "Failures, removed lines and destructive actions." },
};
