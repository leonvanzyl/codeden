import type { FactoryItem, FactoryLimits } from "@codeden/contracts";

/**
 * Who the factory works for (§10.1). On a public repository anyone can open an issue, so the
 * factory only takes on issues from trusted authors by itself: the logins in `trustedAuthors`
 * and the account CodeDen uses on GitHub. Everything else is listed as ignored until a person
 * lets it in, and work let in that way is never merged automatically. Labels are no signal
 * of trust: issue templates can apply them for anyone.
 */

/** Trusted logins, lower-cased (GitHub logins are case-insensitive). */
export function trustedLogins(limits: FactoryLimits, viewer: string | null): Set<string> {
  const logins = new Set(limits.trustedAuthors.map((l) => l.toLowerCase()));
  if (viewer) logins.add(viewer.toLowerCase());
  return logins;
}

/** Whether an issue's author is trusted. An unknown author never is. */
export function isTrustedAuthor(author: string | null, trusted: ReadonlySet<string>): boolean {
  if (!author) return false;
  return trusted.has(author.replace(/^@/, "").toLowerCase());
}

/**
 * Whether the factory may merge an item by itself: auto-merge is on and the work is trusted.
 * Work from an untrusted author that a person (or the PM) let in always waits for a human.
 */
export function mayAutoMerge(
  item: Pick<FactoryItem, "trust">,
  limits: Pick<FactoryLimits, "autoMerge">,
): boolean {
  return limits.autoMerge && item.trust === "trusted";
}
