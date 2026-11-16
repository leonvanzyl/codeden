import { cn } from "@/lib/utils";

/**
 * The CodeDen mark: a hex nut split down the middle into an angular C and D, which also read as
 * the < > of a code tag. Keep the path in step with public/favicon.svg and the icon scripts.
 */
const MARK_PATH =
  "M15.04 5.78L10.7 5.78A1.04 1.04 0 0 0 9.8 6.3L4.5 15.48A1.04 1.04 0 0 0 4.5 16.52L9.8 25.7A1.04 1.04 0 0 0 10.7 26.22L15.04 26.22L15.04 21.54L13.1 21.54A0.52 0.52 0 0 1 12.65 21.28L9.75 16.26A0.52 0.52 0 0 1 9.75 15.74L12.65 10.72A0.52 0.52 0 0 1 13.1 10.46L15.04 10.46ZM16.96 5.78L21.3 5.78A1.04 1.04 0 0 1 22.2 6.3L27.5 15.48A1.04 1.04 0 0 1 27.5 16.52L22.2 25.7A1.04 1.04 0 0 1 21.3 26.22L16.96 26.22ZM19.32 12.22A0.42 0.42 0 0 1 20.1 12.01L22.25 15.74A0.52 0.52 0 0 1 22.25 16.26L20.1 19.99A0.42 0.42 0 0 1 19.32 19.78Z";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-foreground/[0.06]" />
      <path d={MARK_PATH} fillRule="evenodd" className="fill-primary" />
    </svg>
  );
}
