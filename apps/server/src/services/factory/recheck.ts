import type { FactoryItem } from "@codeden/contracts";

/**
 * Re-checks of conflict resolutions (§10.1, Conflicts). After an agent resolved merge conflicts
 * on an approved PR, the reviewer re-checks only the resolution. Each re-check answers for the
 * head it was asked about: its approval settles what is owed only while that head is still the
 * PR's head. A newer head (another resolution, another push) is re-checked against the approved
 * one in turn, so nothing merges until the PR's current head has an approved re-check.
 *
 * Nudges:
 * - `recheck_<approved head>`: a re-check is owed; the PR's head is compared with that head;
 * - `recheck_sent_<head>`: the re-check of that head was asked for (one at a time; the bare
 *   `recheck_sent` of earlier versions names no head, so its approval is asked for again);
 * - `recheck_ok_<head>`: a re-check approved that head.
 */

const RECHECK = "recheck_";
const SENT = "recheck_sent";
const OK = "recheck_ok_";

const isSent = (k: string) => k === SENT || k.startsWith(`${SENT}_`);
const isOk = (k: string) => k.startsWith(OK);
const isOwed = (k: string) => k.startsWith(RECHECK) && !isSent(k) && !isOk(k);

/** The nudge recording that a re-check is owed, comparing the PR's head with `approvedHead`. */
export function owedRecheck(approvedHead: string, at: string): FactoryItem["nudges"] {
  return { [`${RECHECK}${approvedHead}`]: at };
}

/** The head the PR's current head is re-checked against (the last approved one); null when none is owed. */
export function recheckOf(item: Pick<FactoryItem, "nudges">): string | null {
  const key = Object.keys(item.nudges).find(isOwed);
  return key ? key.slice(RECHECK.length) : null;
}

/**
 * The head the outstanding re-check request is about: "" when it names none (sent by an
 * earlier version), null when no request is out.
 */
export function recheckSentFor(item: Pick<FactoryItem, "nudges">): string | null {
  const key = Object.keys(item.nudges).find(isSent);
  if (key === undefined) return null;
  return key === SENT ? "" : key.slice(SENT.length + 1);
}

/** The nudge recording that the re-check of `head` was asked for. */
export function recheckSent(head: string | null, at: string): FactoryItem["nudges"] {
  return { [`${SENT}_${head ?? ""}`]: at };
}

/** Whether a nudge is part of a re-check still owed (kept when the item starts afresh). */
export function isRecheckObligation(key: string): boolean {
  return isOwed(key) || isOk(key);
}

/** The nudges without any re-check marks: nothing is owed any more. */
export function withoutRecheck(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  return Object.fromEntries(Object.entries(nudges).filter(([k]) => !k.startsWith(RECHECK)));
}

/** The nudges without the outstanding request: whichever reviewer takes the re-check is asked again. */
export function withoutRecheckRequest(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  return Object.fromEntries(Object.entries(nudges).filter(([k]) => !isSent(k)));
}

/**
 * A re-check approved: it answers for the head it was asked about, recorded as approved for
 * `settleRecheck` to compare with the PR's head. An approval that names no head approves
 * nothing, so the re-check is asked for again.
 */
export function approveRecheck(nudges: FactoryItem["nudges"], at: string): FactoryItem["nudges"] {
  const head = recheckSentFor({ nudges });
  const rest = withoutRecheckRequest(nudges);
  return head ? { ...rest, [`${OK}${head}`]: at } : rest;
}

/**
 * Settle an approved re-check against the PR's current head. An approval of that head clears
 * what was owed. An approval of an older head (the PR moved on before its verdict) makes that
 * head the one the current head is re-checked against, and the reviewer is asked again.
 */
export function settleRecheck(
  nudges: FactoryItem["nudges"],
  headSha: string | null,
): FactoryItem["nudges"] {
  const approved = Object.keys(nudges).filter(isOk);
  const last = approved.at(-1);
  if (!last) return nudges;
  const owed = Object.keys(nudges).find(isOwed);
  if (!owed || (headSha && nudges[`${OK}${headSha}`])) return withoutRecheck(nudges);
  const at = nudges[owed] ?? "";
  const rest = Object.fromEntries(Object.entries(nudges).filter(([k]) => !isOk(k) && k !== owed));
  return { ...rest, ...owedRecheck(last.slice(OK.length), at) };
}
