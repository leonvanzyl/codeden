import { GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prRequestedHint } from "@/lib/pull-request";
import { useLayoutStore } from "@/stores/layout";
import { useAskForPullRequest, usePullRequestOffer } from "./open-pr";

/**
 * The disabled "PR requested" control that replaces **Open PR** while a request is in progress.
 * A disabled button takes no pointer events, so the wrapper carries the hover text: queued
 * behind the running turn, or being opened.
 */
export function PrRequestedButton({
  requested,
  size,
  variant,
}: {
  requested: "queued" | "sent";
  size: "xs" | "sm";
  variant?: "ghost";
}) {
  return (
    <span title={prRequestedHint(requested)} className="inline-flex">
      <Button size={size} variant={variant} disabled>
        <GitPullRequest /> PR requested
      </Button>
    </span>
  );
}

/**
 * The Push toast's action, kept live: **Open PR**, "PR requested" while a request is in
 * progress (pressed here, in the Git bar or in the Issue / PR tab), or the session's open PR.
 */
export function PushToastPrAction({ sessionId }: { sessionId: string }) {
  const offer = usePullRequestOffer(sessionId);
  const askForPr = useAskForPullRequest(sessionId);
  const openTab = useLayoutStore((s) => s.openRightTab);
  if (offer.pr) {
    return (
      <button type="button" data-button data-action onClick={() => openTab("github")}>
        View PR #{offer.pr.number}
      </button>
    );
  }
  if (offer.requested) {
    return (
      <span title={prRequestedHint(offer.requested)} className="inline-flex">
        <button
          type="button"
          data-button
          data-action
          disabled
          className="opacity-60"
          style={{ cursor: "default" }}
        >
          PR requested
        </button>
      </span>
    );
  }
  if (!offer.canAsk) return null;
  return (
    <button type="button" data-button data-action onClick={askForPr}>
      Open PR
    </button>
  );
}
