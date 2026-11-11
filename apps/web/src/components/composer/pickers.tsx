import type { AutonomyLevel } from "@codeden/contracts";
import { Check, ClipboardList } from "lucide-react";
import { AUTONOMY, AUTONOMY_LEVELS } from "@/components/thread/autonomy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TRIGGER_CLASS } from "./model-picker/trigger";

/**
 * Plan mode on or off. Shown only where the provider reports `capabilities.planMode`: the
 * agent explores and proposes a plan, and edits only once the plan is approved.
 */
export function PlanToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(TRIGGER_CLASS, value && "bg-primary/10 text-primary hover:text-primary")}
          aria-label="Plan mode"
          aria-pressed={value}
          disabled={disabled}
          onClick={() => onChange(!value)}
        >
          <ClipboardList className="size-3.5" />
          Plan
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {value
          ? "Plan mode is on: the agent plans without editing, and starts once you approve the plan."
          : "Plan first: the agent explores and proposes a plan before it changes anything."}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Permissions picker (§11.2): Read-only, Supervised, Auto or Full, one plain line each.
 * Read-only is offered only when the provider enforces it (`readOnlySupported`). Provider,
 * model and effort live in `model-picker/`.
 */
export function AutonomyPicker({
  value,
  onChange,
  readOnlySupported = true,
  heading = "Permissions for this session",
  disabled,
}: {
  value: AutonomyLevel;
  onChange: (v: AutonomyLevel) => void;
  /** False when the session's provider cannot enforce Read-only. */
  readOnlySupported?: boolean;
  heading?: string;
  disabled?: boolean;
}) {
  const a = AUTONOMY[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={TRIGGER_CLASS}
          aria-label="Permissions"
          disabled={disabled}
        >
          <a.icon className={cn("size-3.5", a.tone)} />
          {a.short}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" data-testid="permissions-menu">
        <DropdownMenuLabel className="text-2xs">{heading}</DropdownMenuLabel>
        {AUTONOMY_LEVELS.map((level) => {
          const o = AUTONOMY[level];
          const unavailable = level === "read_only" && !readOnlySupported;
          return (
            <DropdownMenuItem
              key={level}
              disabled={unavailable}
              onSelect={() => onChange(level)}
              className="items-start py-1.5"
            >
              <o.icon className={cn("mt-0.5 size-4", o.tone)} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{o.label}</span>
                <span className="block text-2xs text-muted-foreground">
                  {unavailable ? "This provider can't enforce read-only." : o.description}
                </span>
              </span>
              {level === value && <Check className="mt-0.5 size-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
