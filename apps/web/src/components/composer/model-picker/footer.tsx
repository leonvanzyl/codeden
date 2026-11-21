import { ArrowRight, Check, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A full-width choice in the picker footer, such as "Auto". */
export function PickerFooterChoice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent",
        active && "text-foreground",
      )}
    >
      <Sparkles className="size-3.5" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check className="size-3.5" aria-hidden />}
    </button>
  );
}

/** A note in the picker footer with one action beside it, such as a link to a setting. */
export function PickerFooterAction({
  note,
  action,
  onClick,
}: {
  note: ReactNode;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 px-2 py-0.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">{note}</span>
      <button
        type="button"
        onClick={onClick}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-primary outline-none hover:bg-accent focus-visible:bg-accent"
      >
        {action}
        <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
