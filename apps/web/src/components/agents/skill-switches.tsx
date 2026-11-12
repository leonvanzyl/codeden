import {
  type AgentConfigFile,
  type AgentSkill,
  agentConfigFeatures,
  type SkillSwitchDiff,
  type SkillSwitchRequest,
} from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { fileKey, type RowAddon } from "./config-files-view";
import { PatchDialog } from "./patch-dialog";
import { SWITCH_SCOPE_NOTE, skillStateLabel, skillStateTitle } from "./skill-state";

/** A switch waiting for its diff to be confirmed. */
interface Pending {
  skill: AgentSkill;
  req: SkillSwitchRequest;
}

/**
 * Skill switches for the Skills tab (§12.4): each skill's state from its provider's native
 * setting, a switch per row, and the diff preview before the setting is written.
 */
export function useSkillSwitches(projectId: string | null) {
  const client = useClient();
  const queryClient = useQueryClient();
  const queryKey = ["agent-config-skills", projectId];
  const list = useQuery({ queryKey, queryFn: () => client.agentConfig.listSkills(projectId) });
  const [pending, setPending] = useState<Pending | null>(null);
  const [diff, setDiff] = useState<SkillSwitchDiff | undefined>();
  const [diffError, setDiffError] = useState<string | null>(null);

  const byFile = new Map((list.data?.skills ?? []).map((s) => [fileKey(s.file), s]));

  const ask = async (skill: AgentSkill, enabled: boolean) => {
    const { root, projectId: fileProject, path } = skill.file;
    const req: SkillSwitchRequest = {
      root,
      ...(fileProject ? { projectId: fileProject } : {}),
      path,
      provider: skill.provider,
      enabled,
      ...(projectId ? { listProjectId: projectId } : {}),
    };
    setPending({ skill, req });
    setDiff(undefined);
    setDiffError(null);
    try {
      setDiff(await client.agentConfig.diffSkillSwitch(req));
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    }
  };

  const change = useMutation({
    mutationFn: (p: Pending) => client.agentConfig.switchSkill(p.req),
    onSuccess: (res, p) => {
      setPending(null);
      queryClient.setQueryData(queryKey, { skills: res.skills });
      // Sessions' What's loaded and `/` menus read the same setting.
      void queryClient.invalidateQueries({ queryKey: ["agent-config-loaded"] });
      toast.success(`Switched ${p.req.enabled ? "on" : "off"} ${p.skill.name}`, {
        description: res.backupPath ? `Backup: ${res.backupPath}` : (res.file ?? undefined),
      });
    },
    onError: (e) => toast.error("Not changed", { description: e.message }),
  });

  /** The switch, chip and dimming for a skill row; nothing for files that aren't listed skills. */
  const addon = (f: AgentConfigFile): RowAddon | undefined => {
    const skill = byFile.get(fileKey(f));
    if (!skill || !agentConfigFeatures[skill.provider].skillSwitches) return undefined;
    const label = skillStateLabel(skill);
    const title = skillStateTitle(skill);
    return {
      muted: !skill.enabled,
      chip: label ? (
        <span className="text-muted-foreground" title={title}>
          {label}
        </span>
      ) : undefined,
      end: (
        <Switch
          size="sm"
          checked={skill.enabled}
          onCheckedChange={(on) => void ask(skill, on)}
          aria-label={`${skill.name}: ${skill.enabled ? "on" : "off"}`}
          title={title}
          data-testid="skill-switch"
        />
      ),
    };
  };

  const verb = pending?.req.enabled ? "on" : "off";
  const dialog = (
    <PatchDialog
      open={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
      title={pending ? `Switch ${verb} the ${pending.skill.name} skill` : ""}
      note={diff?.changed ? SWITCH_SCOPE_NOTE[diff.scope] : undefined}
      diff={diff}
      error={diffError}
      saving={change.isPending}
      confirmLabel={`Switch ${verb}`}
      onConfirm={() => pending && change.mutate(pending)}
    />
  );

  return { addon, dialog, refetch: () => list.refetch() };
}
