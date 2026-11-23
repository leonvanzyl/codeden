/** Preferred providers when the choice is `auto`, in order. */
const AUTO_ORDER = ["claude", "codex", "opencode", "cursor", "gemini"];

/**
 * The providers a runner loaded, in the order `auto` tries them: the preferred ones first, then
 * any other in the runner's order. Only orders `loaded`: an id it doesn't hold never comes back.
 */
export function autoOrder(loaded: readonly string[]): string[] {
  return [
    ...AUTO_ORDER.filter((id) => loaded.includes(id)),
    ...loaded.filter((id) => !AUTO_ORDER.includes(id)),
  ];
}
