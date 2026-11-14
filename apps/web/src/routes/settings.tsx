import { CODEDEN_VERSION } from "@codeden/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AppWindow,
  Bell,
  Bot,
  Cpu,
  GitPullRequest,
  ImageIcon,
  Info,
  Keyboard,
  type LucideIcon,
  Mic,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  AutonomySettings,
  GeneralSettings,
  ProviderSettings,
  UtilitySettings,
} from "@/components/settings/sections-core";
import { DesktopSettings } from "@/components/settings/sections-desktop";
import { GithubSettings } from "@/components/settings/sections-github";
import { ImageSettings } from "@/components/settings/sections-images";
import { NotificationSettings } from "@/components/settings/sections-media";
import { NetworkSettings } from "@/components/settings/sections-network";
import { VoiceSettings } from "@/components/settings/sections-voice";
import { SettingsSection } from "@/components/settings/settings-ui";
import { UpdateCheck } from "@/components/settings/update-check";
import { Logo } from "@/components/shell/logo";
import { ShortcutList } from "@/components/shell/shortcuts";
import { isMockMode } from "@/lib/api";
import { platform } from "@/lib/platform";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

function About() {
  // The server's version (the web bundle's constant may be older after a relabelled build).
  const version = useSnapshot().data?.serverVersion ?? CODEDEN_VERSION;
  return (
    <SettingsSection title="About">
      {/* A narrow card (a phone, a squeezed column): the logo above the text, which keeps the width. */}
      <div className="@container">
        <div className="flex flex-col items-start gap-3 p-5 @[30rem]:flex-row @[30rem]:items-center @[30rem]:gap-4">
          <Logo className="size-10 @[30rem]:size-12" />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">
              CodeDen{" "}
              <span className="font-mono text-xs font-normal text-muted-foreground">
                v{version}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              A local-first harness for coding agents. Open source under the MIT license. No
              accounts, no telemetry.
            </p>
            <UpdateCheck />
            {isMockMode && (
              <p className="mt-1 text-2xs text-status-waiting">
                Running against the built-in mock server.
              </p>
            )}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

const SECTIONS: { id: string; label: string; icon: LucideIcon; render: () => ReactNode }[] = [
  { id: "general", label: "General", icon: Settings2, render: () => <GeneralSettings /> },
  { id: "providers", label: "Providers", icon: Bot, render: () => <ProviderSettings /> },
  { id: "autonomy", label: "Autonomy", icon: ShieldCheck, render: () => <AutonomySettings /> },
  { id: "github", label: "GitHub", icon: GitPullRequest, render: () => <GithubSettings /> },
  { id: "voice", label: "Voice", icon: Mic, render: () => <VoiceSettings /> },
  { id: "images", label: "Image generation", icon: ImageIcon, render: () => <ImageSettings /> },
  { id: "utility", label: "Utility model", icon: Cpu, render: () => <UtilitySettings /> },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    render: () => <NotificationSettings />,
  },
  { id: "network", label: "Network access", icon: Smartphone, render: () => <NetworkSettings /> },
  ...(platform.capabilities.osIntegration
    ? [{ id: "desktop", label: "App", icon: AppWindow, render: () => <DesktopSettings /> }]
    : []),
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, render: () => <ShortcutList /> },
  { id: "about", label: "About", icon: Info, render: () => <About /> },
];

/** Settings with a left section nav. */
export function SettingsPage({ section }: { section: string }) {
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const navigate = useNavigate();
  return (
    <>
      <PageHeader icon={<Settings2 />} title="Settings" meta={active?.label} />
      {/* Phones: a section picker instead of the side nav. */}
      <div className="shrink-0 border-b border-border px-4 py-2 md:hidden">
        <select
          aria-label="Settings section"
          className="h-10 w-full rounded-lg border border-border bg-background px-3 text-[13px]"
          value={active?.id}
          onChange={(e) =>
            void navigate({ to: "/settings/$section", params: { section: e.target.value } })
          }
          data-testid="settings-section-picker"
        >
          {SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 space-y-0.5 border-r border-border p-3 md:block">
          {SECTIONS.map((s) => (
            <Link
              key={s.id}
              to="/settings/$section"
              params={{ section: s.id }}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground pointer-coarse:h-10",
                s.id === active?.id && "bg-accent text-foreground",
              )}
            >
              <s.icon className={cn("size-4", s.id === active?.id && "text-primary")} />
              {s.label}
            </Link>
          ))}
          <div className="my-2 h-px bg-border" />
          <Link
            to="/agents"
            className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <SlidersHorizontal className="size-4" /> Agent configuration
          </Link>
          <Link
            to="/setup"
            className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Sparkles className="size-4" /> First-run setup
          </Link>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
            {active?.render()}
          </div>
        </div>
      </div>
    </>
  );
}
