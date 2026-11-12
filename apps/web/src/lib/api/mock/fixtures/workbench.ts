import type { DiffFile, SlashCommand } from "@codeden/contracts";
import type { FileNode } from "../../types";
import { cartPatch, countLines, indexPatch, searchPatch, specPatch, tokensPatch } from "./patches";

const diffFile = (
  path: string,
  patch: string,
  change: DiffFile["change"] = "modify",
): DiffFile => ({
  path,
  change,
  patch,
  ...countLines(patch),
});

export const sessionDiffs: Record<string, DiffFile[]> = {
  "s-a11y": [diffFile("src/theme/tokens.css", tokensPatch)],
  "s-checkout": [
    diffFile("src/checkout/useCart.ts", cartPatch),
    diffFile("tests/e2e/checkout.spec.ts", specPatch),
  ],
  "s-search": [
    diffFile("src/search/index.ts", indexPatch),
    diffFile("src/search/SearchFilters.tsx", searchPatch, "add"),
  ],
};

const f = (path: string, status?: FileNode["status"]): FileNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "file",
  status,
});
const d = (path: string, children: FileNode[]): FileNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "dir",
  children,
});

export const fileTree: FileNode[] = [
  d(".codeden", [f(".codeden/project.json"), f(".codeden/VISION.md")]),
  d("src", [
    d("src/checkout", [
      f("src/checkout/CartTable.tsx"),
      f("src/checkout/CheckoutForm.tsx"),
      f("src/checkout/useCart.ts", "modified"),
    ]),
    d("src/components", [f("src/components/Button.tsx"), f("src/components/ProductCard.tsx")]),
    d("src/search", [f("src/search/index.ts"), f("src/search/FilterChip.tsx")]),
    f("src/main.tsx"),
    f("src/router.tsx"),
  ]),
  d("tests", [
    d("tests/e2e", [f("tests/e2e/checkout.spec.ts", "modified"), f("tests/e2e/search.spec.ts")]),
  ]),
  f("AGENTS.md"),
  f("CLAUDE.md"),
  f("package.json"),
  f("README.md"),
];

export const fileContents: Record<string, string> = {
  "src/checkout/useCart.ts": `import { useCallback, useRef, useState } from "react";
import type { CartLine } from "./types";

/**
 * Cart state for the checkout flow. Prices are computed server-side so discounts,
 * taxes and stock rules stay in one place.
 */
export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [total, setTotal] = useState(0);
  const requestId = useRef(0);

  const updateQuantity = useCallback(async (sku: string, quantity: number) => {
    setLines((prev) => prev.map((l) => (l.sku === sku ? { ...l, quantity } : l)));
    const id = ++requestId.current;
    const res = await fetch("/api/cart/price", {
      method: "POST",
      body: JSON.stringify({ sku, quantity }),
    });
    const { total: next } = await res.json();
    // Ignore responses that arrive after a newer request (the source of the flake).
    if (id === requestId.current) setTotal(next);
  }, []);

  return { lines, total, updateQuantity };
}
`,
  "package.json": `{
  "name": "storefront",
  "version": "2.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
`,
};

export const slashCommands: SlashCommand[] = [
  { name: "plan", description: "Switch to plan mode for the next turn", kind: "command" },
  { name: "compact", description: "Summarise the conversation to free context", kind: "command" },
  { name: "review", description: "Ask a separate agent to review the changes", kind: "command" },
  { name: "pr", description: "Push the branch and open a pull request", kind: "command" },
  { name: "clear", description: "Start a fresh conversation in this worktree", kind: "command" },
  {
    name: "frontend-design",
    description: "Distinctive, production-grade UI work",
    kind: "skill",
    provider: "claude",
  },
  {
    name: "playwright-e2e",
    description: "Write and debug Playwright end-to-end tests",
    kind: "skill",
    provider: "claude",
  },
  {
    name: "release-notes",
    description: "Draft release notes from merged PRs",
    kind: "skill",
    provider: "codex",
  },
];

/** Flatten the file tree into mention candidates. */
export function allPaths(nodes: FileNode[] = fileTree): { path: string; kind: "file" | "dir" }[] {
  return nodes.flatMap((n) => [{ path: n.path, kind: n.kind }, ...allPaths(n.children ?? [])]);
}
