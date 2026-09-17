import type * as React from "react";

import { cn } from "@/lib/utils";

/** Glass card surface for sidebar/plugin panes: `rounded-xl` shell with the
 * glass hairline border over the glass tint fill. Both donors
 * (DurePluginsPane's expanded plugin card, PluginSidebarContent's empty-state
 * card) use exactly `rounded-xl border border-glass-hairline bg-glass-tint`;
 * layout, padding, and overflow handling stay caller-side via `className`.
 * Pure container, no variants. */
export function GlassPanel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(
        "rounded-xl border border-glass-hairline bg-glass-tint",
        className,
      )}
      {...props}
    />
  );
}
