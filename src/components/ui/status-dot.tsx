import { cn } from "@/lib/utils";
import { Titled } from "@/components/ui/tooltip";

// Tone → color token, derived from the inline dot copies this primitive folds
// (PaneChrome, SshPane, Toaster, the mobile settings pages, StatsPage legend).
// `error` deliberately maps to the destructive token — every folded inline dot
// used `bg-destructive`; agent-state dots keep their own `--status-error`
// palette in agents/StatusBits.
const TONE_CLASSES = {
  run: "bg-status-run",
  warn: "bg-status-warn",
  error: "bg-destructive",
  done: "bg-status-done",
  blocked: "bg-status-blocked",
  // Kept verbatim from PhoneHubPage: the dot inherits whatever `--status-idle`
  // resolves to at the call site (no `--color-status-idle` utility exists).
  idle: "bg-[var(--status-idle)]",
  muted: "bg-muted-foreground",
} as const;

/** One colored status dot. Decorative (`aria-hidden`) — callers own the
 * adjacent accessible text; `title` stays a visual-only tooltip. Base size is
 * 6px (`size-1.5`); sites with a different dot size pass it via `className`
 * (tailwind-merge resolves the conflict), as do per-site color softenings. */
export function StatusDot({
  tone,
  pulse,
  className,
  title,
}: {
  tone: "run" | "warn" | "error" | "done" | "blocked" | "idle" | "muted";
  /** Transient states (connecting, pending) pulse; settled states stay steady. */
  pulse?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <Titled title={title}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          TONE_CLASSES[tone],
          pulse && "animate-pulse",
          className,
        )}
      />
    </Titled>
  );
}
