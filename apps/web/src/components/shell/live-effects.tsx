import type { InboxItem, Snapshot } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useClient } from "@/lib/api";
import { attentionTarget, isBlockingKind } from "@/lib/attention/blocking";
import {
  createUpdateGrouper,
  describeUpdates,
  notifiesFor,
  UPDATE_TOAST_MS,
} from "@/lib/attention/updates";
import { platform } from "@/lib/platform";
import { snapshotKey, useSnapshot } from "@/lib/queries";
import { onLiveEvent } from "@/lib/realtime";
import { startReadAloud } from "@/lib/voice/read-aloud";
import { useAttention } from "./use-attention";

const blockingVerb: Partial<Record<InboxItem["kind"], string>> = {
  approval: "Approval needed",
  question: "Question from an agent",
};

/**
 * Side effects of live events: update toasts and desktop notifications for new inbox items
 * (`lib/attention/updates.ts`: only the categories switched on, a burst grouped into one), the
 * unread badge, the attention cues for items that block an agent (`useAttention`), and
 * read-aloud of the final message when a turn completes (§11.1, §11.3). A session that fails
 * raises a `run_failed` item, so the failure toasts once, through that item.
 */
export function LiveEffects() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useSnapshot();
  const openCount = data?.inbox.filter((i) => i.status === "open").length ?? 0;
  const grouper = useMemo(() => createUpdateGrouper(), []);

  useEffect(() => platform.setBadge(openCount), [openCount]);
  // After the badge, so a flashing title is redrawn on top of it.
  useAttention();

  useEffect(() => {
    return onLiveEvent((env) => {
      if (env.type !== "inbox.created") return;
      const snap = queryClient.getQueryData<Snapshot>(snapshotKey);
      if (!snap) return;
      const item = env.payload.item;
      const settings = snap.settings.notifications;
      const background = settings.browser && !platform.isFocused();
      if (isBlockingKind(item)) {
        // The sticky toast comes from useAttention; this is its desktop notification.
        if (background) {
          platform.notify(blockingVerb[item.kind] ?? "CodeDen", {
            body: item.title,
            tag: item.id,
            onClick: () => void navigate(attentionTarget(item)),
          });
        }
        return;
      }
      if (!notifiesFor(item, settings)) return;
      const batch = grouper.add(item);
      const view = describeUpdates(batch.items);
      const open = () => void navigate(view.target);
      if (settings.toasts) {
        const show = view.tone === "error" ? toast.error : toast;
        show(view.title, {
          id: batch.id,
          description: view.description,
          duration: UPDATE_TOAST_MS,
          action: { label: view.action, onClick: open },
        });
      }
      // Same tag for the whole batch, so a burst replaces one notification.
      if (background) {
        platform.notify(view.title, { body: view.description, tag: batch.id, onClick: open });
      }
    });
  }, [queryClient, navigate, grouper]);

  // Read the final message aloud when any session's turn completes (§11.3).
  useEffect(() => startReadAloud(client, queryClient), [client, queryClient]);

  return null;
}
