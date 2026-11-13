import { BellRing, Check, RotateCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform";

/**
 * How to get notifications back once they are blocked, by what this platform can do: the
 * desktop app's come from the operating system, and a browser's are a per-site permission.
 */
function blockedHelp(osIntegration: boolean): string {
  return osIntegration
    ? "Turned off for CodeDen in your system's notification settings. Turn them on there, then check again."
    : "Blocked for this site. To allow them, open the site settings (the icon left of the address bar), allow notifications, then check again.";
}

/**
 * First-run setup (§14): the notifications row. Browsers only show notifications on secure
 * pages, so a phone reaching CodeDen over plain http on the network (§13) can't get them at
 * all; the row says so instead of pointing at a permission the browser won't grant there.
 */
export function NotificationsRow() {
  const [permission, setPermission] = useState(platform.notificationPermission());
  const insecure = typeof window !== "undefined" && window.isSecureContext === false;
  const unavailable = permission !== "granted" && insecure && !platform.capabilities.osIntegration;
  const checkAgain = () => {
    const next = platform.notificationPermission();
    setPermission(next);
    if (next === "denied") {
      toast("Notifications are still blocked", {
        description: "If you just allowed them, reload the page.",
      });
    }
  };
  return (
    <div className="flex items-center gap-3 px-4 py-3.5" data-testid="setup-notifications">
      <BellRing className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">Browser notifications</div>
        <div className="text-2xs text-muted-foreground">
          {unavailable
            ? "Browsers only allow notifications on secure pages, and this one is plain http. Open CodeDen on the computer that runs it to get them."
            : permission === "denied"
              ? blockedHelp(platform.capabilities.osIntegration)
              : "Know when an agent needs you, even in another tab."}
        </div>
      </div>
      {permission === "granted" ? (
        <span className="flex items-center gap-1 text-2xs text-status-done">
          <Check className="size-3" /> Allowed
        </span>
      ) : unavailable ? (
        <span className="text-2xs text-muted-foreground">Unavailable</span>
      ) : permission === "denied" ? (
        <Button size="sm" variant="outline" onClick={checkAgain}>
          <RotateCw /> Check again
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={permission === "unsupported"}
          onClick={async () => setPermission(await platform.requestNotificationPermission())}
        >
          Allow
        </Button>
      )}
    </div>
  );
}
