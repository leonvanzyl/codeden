import type { GithubIssue, InboxItem, RawEventEnvelope } from "@codeden/contracts";
import { triageItemId } from "../automations/triage";
import type { InboxService } from "../inbox-service";
import type { GithubStore } from "./store";

/** The issues a batch of sync events carries (`github.synced` and `issue.*`). */
export function syncedIssues(events: RawEventEnvelope[]): GithubIssue[] {
  const issues: GithubIssue[] = [];
  for (const e of events) {
    if (e.type === "github.synced") issues.push(...(e.payload as { issues: GithubIssue[] }).issues);
    else if (e.type.startsWith("issue.")) issues.push((e.payload as { issue: GithubIssue }).issue);
  }
  return issues;
}

/**
 * A triage decision ("Should I take this on?") resolves on its own once its issue is closed on
 * GitHub (#673), and stays in the inbox's history with why. Reopening the issue doesn't revive
 * it: the next triage run raises the decision again. Returns the items it resolved.
 */
export function resolveClosedTriage(
  inbox: InboxService,
  issues: Iterable<Pick<GithubIssue, "projectId" | "number" | "state" | "stateReason">>,
): InboxItem[] {
  const settled: InboxItem[] = [];
  for (const issue of issues) {
    if (issue.state !== "closed") continue;
    const item = inbox.find(triageItemId(issue.projectId, issue.number));
    if (item?.status !== "open") continue;
    const how = issue.stateReason ? ` as ${issue.stateReason.replace("_", " ")}` : "";
    const note = `Issue #${issue.number} was closed${how}`;
    settled.push(inbox.settle(item, { by: "codeden", note }));
  }
  return settled;
}

/** The synced issues of the open triage decisions (to resolve those already closed). */
export function triagedIssues(
  inbox: InboxService,
  data: Pick<GithubStore, "issue">,
): GithubIssue[] {
  return inbox
    .list()
    .flatMap((i) =>
      i.kind === "triage" && i.projectId && i.issue
        ? (data.issue(i.projectId, i.issue.number) ?? [])
        : [],
    );
}
