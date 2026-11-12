import type { NetworkAddress, NetworkStatus, RemoteDevice } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LogOut, Monitor, Smartphone, Wifi } from "lucide-react";
import { toast } from "sonner";
import { QrCode } from "@/components/common/qr-code";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NETWORK_KEY, NetworkPassword } from "./network-password";
import { SettingRow, SettingsSection } from "./settings-ui";

const KIND_LABEL: Record<NetworkAddress["kind"], string> = {
  local: "This computer",
  lan: "Local network",
  vpn: "VPN",
};

/** "iPhone · Safari" from a user agent; good enough to tell your devices apart. */
export function deviceName(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const device = ua.includes("iphone")
    ? "iPhone"
    : ua.includes("ipad")
      ? "iPad"
      : ua.includes("android")
        ? ua.includes("mobile")
          ? "Android phone"
          : "Android tablet"
        : ua.includes("mac os")
          ? "Mac"
          : ua.includes("windows")
            ? "Windows"
            : ua.includes("linux")
              ? "Linux"
              : "Device";
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("firefox") || ua.includes("fxios")
      ? "Firefox"
      : ua.includes("chrome") || ua.includes("crios")
        ? "Chrome"
        : ua.includes("safari")
          ? "Safari"
          : null;
  return browser ? `${device} · ${browser}` : device;
}

function AddressCard({ address, live }: { address: NetworkAddress; live: boolean }) {
  const scannable = address.kind !== "local";
  return (
    <div
      className={cn("flex items-center gap-4 px-4 py-3.5", !live && "opacity-60")}
      data-testid="network-address"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{address.label}</span>
          {address.kind !== "local" && (
            <span className="rounded border border-border px-1.5 py-px text-3xs text-muted-foreground">
              {KIND_LABEL[address.kind]}
            </span>
          )}
        </div>
        <button
          type="button"
          className="mt-1 flex max-w-full items-center gap-1.5 font-mono text-[12.5px] text-muted-foreground hover:text-foreground pointer-coarse:min-h-10"
          onClick={() => void copyWithFeedback(address.url, "Address copied")}
          title="Copy address"
        >
          <span className="truncate">{address.url}</span>
          <Copy className="size-3 shrink-0" />
        </button>
        {address.kind === "local" && (
          <p className="mt-1 text-2xs text-muted-foreground">Only works on this computer.</p>
        )}
      </div>
      {scannable && (
        <QrCode
          value={address.url}
          label={`QR code for ${address.url}`}
          className="size-28 shrink-0 p-1 sm:size-32"
        />
      )}
    </div>
  );
}

function DeviceRow({
  device,
  onSignOut,
  pending,
}: {
  device: RemoteDevice;
  onSignOut: () => void;
  pending: boolean;
}) {
  const mobile = /iphone|ipad|android/i.test(device.label);
  const Icon = mobile ? Smartphone : Monitor;
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="network-device">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium" title={device.label}>
          {deviceName(device.label)}
          {device.current && <span className="ml-2 text-2xs text-primary">This device</span>}
        </div>
        <div className="truncate text-2xs text-muted-foreground">
          {device.address ?? "Unknown address"} · seen {ago(device.lastSeenAt)} · signed in{" "}
          {ago(device.createdAt)}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onSignOut} disabled={pending}>
        <LogOut /> Sign out
      </Button>
    </div>
  );
}

/**
 * Settings › Network access (§15.1): open CodeDen from a phone or tablet on the same network
 * or over your own VPN. Changing it is for this computer only; remote devices see it read-only.
 */
export function NetworkSettings() {
  const client = useClient();
  const queryClient = useQueryClient();
  const { data: status, error } = useQuery({
    queryKey: NETWORK_KEY,
    queryFn: () => client.network.status(),
    refetchInterval: 15_000,
  });
  const apply = (next: NetworkStatus) => queryClient.setQueryData(NETWORK_KEY, next);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => client.network.setEnabled(enabled),
    onSuccess: (next) => {
      apply(next);
      toast.success(next.enabled ? "Network access is on" : "Network access is off");
    },
    onError: (e) => toast.error("Network access not changed", { description: e.message }),
  });
  const signOut = useMutation({
    mutationFn: (id: string | null) =>
      id ? client.network.signOutDevice(id) : client.network.signOutAll(),
    onSuccess: apply,
    onError: (e) => toast.error("Not signed out", { description: e.message }),
  });

  if (error) {
    return (
      <SettingsSection title="Network access">
        <p className="p-4 text-[13px] text-muted-foreground">
          This CodeDen server doesn't offer network access yet. Update CodeDen to use it.
        </p>
      </SettingsSection>
    );
  }
  if (!status) return null;
  const remote = status.remote;
  const addresses = status.enabled ? status.addresses : status.candidates;

  return (
    <div data-testid="network-settings">
      <SettingsSection
        title="Network access"
        description="Open CodeDen from your phone or tablet on the same Wi-Fi, or from anywhere over your own VPN such as Tailscale. Off by default."
      >
        <SettingRow
          label="Allow network access"
          help={
            remote
              ? "Change this on the computer running CodeDen."
              : status.enabled
                ? "Devices on your network can open CodeDen after signing in with the password."
                : status.passwordSet
                  ? "CodeDen only answers on this computer (127.0.0.1)."
                  : "Set a password below first."
          }
        >
          <Switch
            aria-label="Allow network access"
            data-testid="network-toggle"
            checked={status.enabled}
            disabled={remote || !status.passwordSet || toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
        </SettingRow>
        {!remote && (
          <SettingRow
            label="Password"
            stacked
            help={
              status.passwordSetAt
                ? `Set ${ago(status.passwordSetAt)}. Phones and tablets sign in with it once.`
                : "Phones and tablets sign in with it once. CodeDen stores only a scrambled copy."
            }
          >
            <NetworkPassword passwordSet={status.passwordSet} />
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="Addresses"
        description={
          status.enabled
            ? "Scan a code with your phone's camera, or type the address into its browser."
            : "Where CodeDen will answer once network access is on."
        }
      >
        {addresses.map((a) => (
          <AddressCard key={a.url} address={a} live={status.enabled || a.kind === "local"} />
        ))}
        {status.candidates.length === 1 && (
          <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
            <Wifi className="size-3.5" /> This computer isn't on a network right now.
          </p>
        )}
        <p className="px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
          Away from home, use your own VPN (Tailscale, WireGuard): its address shows up here and
          needs nothing else. These are plain http addresses, so phones won't allow notifications or
          the microphone on them. Tip: open CodeDen on your phone and use Add to Home Screen.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Signed-in devices"
        description="Each device stays signed in for 90 days, or until you sign it out."
      >
        {status.devices.length === 0 ? (
          <p className="px-4 py-3.5 text-[13px] text-muted-foreground">No devices signed in.</p>
        ) : (
          <>
            {status.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                pending={signOut.isPending}
                onSignOut={() => signOut.mutate(d.id)}
              />
            ))}
            <div className="flex justify-end px-4 py-3">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => signOut.mutate(null)}
                disabled={signOut.isPending}
              >
                <LogOut /> Sign out all
              </Button>
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
