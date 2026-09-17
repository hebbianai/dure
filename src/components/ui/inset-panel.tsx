import type * as React from "react";

import { cn } from "@/lib/utils";

/** Recessed inset box that groups secondary detail inside a dialog body.
 * Canonical classes are the exact majority across the folded inline copies
 * (AgentPermissionModeDialog mode grid, KillAgentDialog removal-progress box):
 * `border-border/70 bg-muted/25` on a `rounded-md` shell with `p-2.5`.
 * Pure container — content, density overrides (`px-3 py-2`), and semantics
 * (`aria-live`, roles) stay with the caller; tailwind-merge lets a caller
 * `className` win over the base padding. No variants by contract. */
export function InsetPanel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inset-panel"
      className={cn(
        "rounded-md border border-border/70 bg-muted/25 p-2.5",
        className,
      )}
      {...props}
    />
  );
}
