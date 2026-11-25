import { useMemo } from "react";
import { useCurrentTheme } from "@/stores/theme";
import type { ResolvedTheme } from "./resolve";

/** Syntax themes for the diff and file views (`@pierre/diffs`), by kind. */
export interface DiffThemes {
  dark: string;
  light: string;
}

const CODEDEN: DiffThemes = { dark: "pierre-dark", light: "pierre-light" };

/**
 * CodeDen's own themes keep the views' own colours. Other themes paint the views on their inset
 * surface (`--surface`, see `index.css`); in dark ones the code uses the transcript's code-block
 * theme, whose dimmest tokens (comments) stay above 4.5:1 on those lighter surfaces.
 */
export function diffThemes(theme: ResolvedTheme): DiffThemes {
  return theme.builtIn ? CODEDEN : OTHER;
}

const OTHER: DiffThemes = { dark: "github-dark-default", light: "pierre-light" };

/** The current theme's diff themes; the object stays the same while they don't change. */
export function useDiffThemes(): DiffThemes {
  const theme = useCurrentTheme();
  return useMemo(() => diffThemes(theme), [theme]);
}
