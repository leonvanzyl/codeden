import type { InboxNotify } from "@codeden/contracts";
import { BellRing, Volume2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { chime } from "@/lib/attention/chime";
import { platform } from "@/lib/platform";
import { SettingRow, SettingsSection, useSettings } from "./settings-ui";

/** The inbox categories (`InboxItem.notify`) and what each covers. */
const CATEGORIES: { id: InboxNotify; label: string; help: string }[] = [
  {
    id: "needs_you",
    label: "Needs you",
    help: "PRs only a person can merge, factory decisions it flagged for you, conflicts, budget alerts.",
  },
  {
    id: "failure",
    label: "Failures",
    help: "Your sessions' failed runs, a paused factory loop, a regression, a worktree that couldn't be removed.",
  },
  {
    id: "factory",
    label: "Factory activity",
    help: "What the factory handles itself: its decisions, the PRs it reviews and merges, its sessions' failures, the daily digest.",
  },
  {
    id: "automation",
    label: "Automations",
    help: "Automation results and triage decisions.",
  },
];

export function NotificationSettings() {
  const { settings, update } = useSettings();
  const [permission, setPermission] = useState(platform.notificationPermission());
  const categories = settings.notifications.categories;
  return (
    <SettingsSection
      title="Notifications"
      description="How CodeDen tells you something is waiting."
    >
      <SettingRow
        label="Toasts"
        help="In-app toasts for new inbox items in the categories below. Several at once become one toast."
      >
        <Switch
          checked={settings.notifications.toasts}
          onCheckedChange={(toasts) => update({ notifications: { toasts } })}
        />
      </SettingRow>
      <SettingRow
        label="Notify me about"
        help="For toasts and desktop notifications. Approvals and questions always notify; everything still lands in the inbox."
        stacked
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {CATEGORIES.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{c.label}</div>
                <div className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                  {c.help}
                </div>
              </div>
              <Switch
                aria-label={c.label}
                checked={categories[c.id]}
                onCheckedChange={(on) =>
                  update({ notifications: { categories: { ...categories, [c.id]: on } } })
                }
              />
            </div>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        label="Sound when an agent needs you"
        help="A short chime when an approval or a question arrives, even in the background."
      >
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              chime.unlock();
              chime.play();
            }}
          >
            <Volume2 /> Test
          </Button>
          <Switch
            aria-label="Sound when an agent needs you"
            checked={settings.notifications.sound}
            onCheckedChange={(sound) => update({ notifications: { sound } })}
          />
        </div>
      </SettingRow>
      <SettingRow
        label={
          platform.capabilities.osIntegration ? "System notifications" : "Browser notifications"
        }
        help={
          permission === "denied"
            ? "Blocked in your browser settings."
            : platform.capabilities.osIntegration
              ? "Shown when the CodeDen window isn't focused."
              : "Shown when the CodeDen tab isn't focused."
        }
      >
        <div className="flex items-center gap-2">
          {permission !== "granted" && permission !== "unsupported" && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => setPermission(await platform.requestNotificationPermission())}
            >
              <BellRing /> Allow
            </Button>
          )}
          <Switch
            checked={settings.notifications.browser}
            disabled={permission === "unsupported"}
            onCheckedChange={(browser) => update({ notifications: { browser } })}
          />
        </div>
      </SettingRow>
      <SettingRow label="Send a test notification">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            toast("Approval needed", { description: "Force push to codeden/fix-checkout-flake" });
            platform.notify("Approval needed", {
              body: "Force push to codeden/fix-checkout-flake",
            });
          }}
        >
          Test
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
