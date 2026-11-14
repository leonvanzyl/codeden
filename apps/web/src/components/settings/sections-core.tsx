import type { Role } from "@codeden/contracts";
import { ProviderMark } from "@/components/common/bits";
import { PickerFooterChoice } from "@/components/composer/model-picker/footer";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { KillSwitchButton } from "@/components/factory/kill-switch";
import { AUTONOMY } from "@/components/thread/autonomy";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type ThemePreference, useThemeStore } from "@/stores/theme";
import { AgentEnvironmentSettings } from "./agent-environment";
import { CustomModelSettings } from "./custom-models";
import { ModelVisibilitySettings } from "./model-visibility";
import { ProviderHistorySettings } from "./provider-history";
import { Segmented, SettingRow, SettingsSection, useSettings } from "./settings-ui";
import { UpdateModeSetting } from "./update-mode";

export function GeneralSettings() {
  const { settings, update } = useSettings();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  return (
    <>
      <SettingsSection title="Appearance">
        <SettingRow label="Theme" help="Dark is the default; light mirrors it.">
          <Segmented<ThemePreference>
            value={preference}
            onChange={(v) => {
              setPreference(v);
              update({ appearance: { theme: v } });
            }}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection
        title="Follow-up prompts"
        description="Suggested next prompts appear as chips when a turn completes."
      >
        <SettingRow label="Show follow-up chips">
          <Switch
            checked={settings.followups.enabled}
            onCheckedChange={(v) => update({ followups: { enabled: v } })}
          />
        </SettingRow>
        <SettingRow
          label="Send on click"
          help="Off: a click fills the composer so you can edit first."
        >
          <Switch
            checked={settings.followups.sendOnClick}
            onCheckedChange={(v) => update({ followups: { sendOnClick: v } })}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection
        title="Agent sessions"
        description="What CodeDen does by itself to keep agent sessions going."
      >
        <SettingRow
          label="Pass on pull request feedback"
          help="In sessions you start, tells the agent when its pull request's checks fail, a reviewer requests changes or it has merge conflicts. Once per commit, up to three times per pull request. The project manager follows up on work it started."
        >
          <Switch
            checked={settings.sessions.prFeedback}
            onCheckedChange={(v) => update({ sessions: { prFeedback: v } })}
          />
        </SettingRow>
        <SettingRow
          label="Retry after passing failures"
          help="When a turn fails because the API was overloaded or the connection dropped, continue after 20 s, 90 s and 5 min; after a usage limit, continue once it resets. Applies to every agent session."
        >
          <Switch
            checked={settings.sessions.autoRetry}
            onCheckedChange={(v) => update({ sessions: { autoRetry: v } })}
          />
        </SettingRow>
      </SettingsSection>
      <AgentEnvironmentSettings />
      <SettingsSection title="Background work">
        <SettingRow
          label="Automations"
          help="Master switch. Each automation is still off until you enable it."
        >
          <Switch
            checked={settings.automations.enabled}
            onCheckedChange={(v) => update({ automations: { enabled: v } })}
          />
        </SettingRow>
        <SettingRow
          label="Global factory kill switch"
          help={
            settings.factory.killSwitch
              ? "On: no project's factory loop runs."
              : "Stops every project's factory loop and all factory sessions at once."
          }
        >
          <KillSwitchButton scope="global" on={settings.factory.killSwitch} size="xs" />
        </SettingRow>
        <UpdateModeSetting />
      </SettingsSection>
      <SettingsSection
        title="Worktrees"
        description="Archiving a session removes its worktree unless it has uncommitted changes. Branches and checkpoints are kept, and a cleaned-up worktree is recreated when you message the session again."
      >
        <SettingRow
          label="Clean up inactive worktrees"
          help="Skips sessions with an open pull request and worktrees with uncommitted changes."
        >
          <Switch
            checked={settings.worktrees.cleanup}
            onCheckedChange={(v) => update({ worktrees: { cleanup: v } })}
          />
        </SettingRow>
        <SettingRow label="Inactive for" help="Days without activity before cleanup.">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Input
              type="number"
              min={1}
              max={365}
              aria-label="Days before cleanup"
              disabled={!settings.worktrees.cleanup}
              value={settings.worktrees.afterDays}
              onChange={(e) => {
                const days = Math.round(Number(e.target.value));
                if (days >= 1 && days <= 365) update({ worktrees: { afterDays: days } });
              }}
              className="h-8 w-20 text-xs"
            />
            days
          </div>
        </SettingRow>
      </SettingsSection>
    </>
  );
}

const roles: { role: Role; label: string; help: string }[] = [
  { role: "orchestrator", label: "Orchestrator", help: "Your front door across projects." },
  { role: "pm", label: "Project managers", help: "Triage, planning and follow-up per project." },
  { role: "agent", label: "Agent sessions", help: "Default for new coding sessions." },
];

export function ProviderSettings() {
  const { settings, update } = useSettings();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  return (
    <>
      <SettingsSection
        title="Installed providers"
        description="Detected on this machine and reused with their own logins."
      >
        {providers.map((p) => (
          <SettingRow
            key={p.id}
            label={p.displayName}
            help={`${p.models.length} models · ${Object.entries(p.capabilities).filter(([, v]) => v).length} capabilities`}
          >
            <div className="flex items-center gap-2">
              <ProviderMark provider={p.id} className="size-5" />
              <span className="rounded-full bg-status-done/12 px-2 py-0.5 text-2xs text-status-done">
                Ready
              </span>
            </div>
          </SettingRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Defaults per role" description="Each role can run on any provider.">
        {roles.map(({ role, label, help }) => {
          const current = settings.providers[role];
          const auto = current.provider === "auto";
          return (
            <SettingRow key={role} label={label} help={help}>
              <div className="rounded-lg border border-border px-1 py-0.5">
                <ModelPicker
                  providers={providers}
                  align="end"
                  placeholder="Auto"
                  value={
                    auto
                      ? null
                      : { provider: current.provider, model: current.model, effort: current.effort }
                  }
                  onChange={(next) => update({ providers: { [role]: next } })}
                  footer={(close) => (
                    <PickerFooterChoice
                      active={auto}
                      onClick={() => {
                        update({
                          providers: { [role]: { provider: "auto", model: null, effort: null } },
                        });
                        close();
                      }}
                    >
                      Auto: the first ready provider and its default model
                    </PickerFooterChoice>
                  )}
                />
              </div>
            </SettingRow>
          );
        })}
      </SettingsSection>
      <ModelVisibilitySettings />
      <CustomModelSettings />
      <ProviderHistorySettings />
    </>
  );
}

export function AutonomySettings() {
  const { settings, update } = useSettings();
  return (
    <SettingsSection
      title="Default permissions"
      description="From Read-only to Full, mapped onto each provider's native enforcement. Override per project, per session and per automation."
    >
      <div className="grid gap-2 p-3">
        {(Object.keys(AUTONOMY) as (keyof typeof AUTONOMY)[]).map((level) => {
          const a = AUTONOMY[level];
          const active = settings.autonomy.default === level;
          return (
            <button
              key={level}
              type="button"
              onClick={() => update({ autonomy: { default: level } })}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                active ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-accent/40",
              )}
            >
              <a.icon className={cn("mt-0.5 size-4", a.tone)} />
              <span>
                <span className="block text-[13.5px] font-medium">
                  {a.label}
                  {level === "auto" && (
                    <span className="ml-2 text-2xs font-normal text-muted-foreground">
                      recommended
                    </span>
                  )}
                </span>
                <span className="block text-2xs text-muted-foreground">{a.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <SettingRow
        label="Risky actions"
        help="Writes outside the worktree, force pushes, deleting branches, global installs, unlisted network hosts and secrets access always go to your inbox in Auto."
      >
        <span className="text-2xs text-muted-foreground">Always ask</span>
      </SettingRow>
    </SettingsSection>
  );
}

export function UtilitySettings() {
  const { settings, update } = useSettings();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const jobs = [
    ["followups", "Follow-up suggestions", "When the agent didn't suggest any itself."],
    ["sessionTitles", "Session titles", "Short titles from the first message."],
    ["noticeSummaries", "Notice summaries", "One-line summaries in PM wake-ups."],
    [
      "handoffSummaries",
      "Handoff summaries",
      "What a session did, in the brief of a handoff. Off: its last reply.",
    ],
  ] as const;
  const utilityAuto = settings.utilityModel.provider === "auto";
  return (
    <SettingsSection
      title="Utility model"
      description="One small, cheap model for side jobs. Runs through an installed provider, no extra API key. It also writes read-aloud TL;DRs, chosen in Voice."
    >
      <SettingRow label="Model">
        <div className="rounded-lg border border-border px-1 py-0.5">
          <ModelPicker
            providers={providers}
            align="end"
            effort={false}
            placeholder="Auto (smallest available)"
            value={
              utilityAuto
                ? null
                : {
                    provider: settings.utilityModel.provider,
                    model: settings.utilityModel.model,
                    effort: null,
                  }
            }
            onChange={(next) =>
              update({ utilityModel: { provider: next.provider, model: next.model } })
            }
            footer={(close) => (
              <PickerFooterChoice
                active={utilityAuto}
                onClick={() => {
                  update({ utilityModel: { provider: "auto", model: null } });
                  close();
                }}
              >
                Auto: the smallest available model
              </PickerFooterChoice>
            )}
          />
        </div>
      </SettingRow>
      {jobs.map(([key, label, help]) => (
        <SettingRow key={key} label={label} help={help}>
          <Switch
            checked={settings.utilityModel.jobs[key]}
            onCheckedChange={(v) => update({ utilityModel: { jobs: { [key]: v } } })}
          />
        </SettingRow>
      ))}
    </SettingsSection>
  );
}
