import type { AutonomyLevel, Project } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { PickerFooterChoice } from "@/components/composer/model-picker/footer";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { Segmented, SettingRow, SettingsSection } from "@/components/settings/settings-ui";
import { AUTONOMY, AUTONOMY_LEVELS } from "@/components/thread/autonomy";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshotData } from "@/lib/queries";

const SETTINGS_DEFAULT = "default";

/**
 * Project page > Settings: what new sessions in this project start with (#261). The default
 * agent (provider, model and effort) and permissions override Settings for this project; the
 * New session draft starts from them, and a pick there still wins.
 */
export function ProjectSettings({ project }: { project: Project }) {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const globalAutonomy = useSnapshotData<AutonomyLevel>((s) => s.settings.autonomy.default, "auto");
  const { setSessionDefaults } = useProjectActions();
  const inherits = project.defaultProvider === null;
  const toSettings = (
    <Link
      to="/settings/$section"
      params={{ section: "providers" }}
      className="underline underline-offset-2 hover:text-foreground"
    >
      Settings → Providers → Agent sessions
    </Link>
  );

  return (
    <SettingsSection
      title="New sessions"
      description="What sessions you start in this project begin with. You can still pick something else in each new session."
    >
      <SettingRow
        label="Default agent"
        help={
          inherits ? (
            <>Not set: new sessions use {toSettings}.</>
          ) : (
            <>Used instead of {toSettings} for this project.</>
          )
        }
      >
        <div className="rounded-lg border border-border px-1 py-0.5" data-testid="project-agent">
          <ModelPicker
            providers={providers}
            align="end"
            placeholder="Settings default"
            value={
              inherits
                ? null
                : {
                    provider: project.defaultProvider as string,
                    model: project.defaultModel,
                    effort: project.defaultEffort,
                  }
            }
            onChange={(next) =>
              void setSessionDefaults(project, {
                defaultProvider: next.provider,
                defaultModel: next.model,
                defaultEffort: next.effort,
              })
            }
            footer={(close) => (
              <PickerFooterChoice
                active={inherits}
                onClick={() => {
                  void setSessionDefaults(project, {
                    defaultProvider: null,
                    defaultModel: null,
                    defaultEffort: null,
                  });
                  close();
                }}
              >
                Settings default: Agent sessions in Settings
              </PickerFooterChoice>
            )}
          />
        </div>
      </SettingRow>
      <SettingRow
        label="Permissions"
        help={`Default: ${AUTONOMY[globalAutonomy].short}, from Settings → Autonomy.`}
        stacked
      >
        <Segmented<AutonomyLevel | typeof SETTINGS_DEFAULT>
          value={project.autonomy ?? SETTINGS_DEFAULT}
          onChange={(v) =>
            void setSessionDefaults(project, { autonomy: v === SETTINGS_DEFAULT ? null : v })
          }
          options={[
            { value: SETTINGS_DEFAULT, label: "Default" },
            ...AUTONOMY_LEVELS.map((level) => ({ value: level, label: AUTONOMY[level].short })),
          ]}
        />
      </SettingRow>
    </SettingsSection>
  );
}
