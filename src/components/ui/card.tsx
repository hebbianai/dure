import type * as React from "react";

import { cn } from "@/lib/utils";

/** Settings-page Figma card surface: a hairline `border-border` outline with
 * the family's 17px padding. `border-border` is spelled out even though the
 * base layer already defaults border color to it (src/index.css `@layer base`)
 * so the surface does not depend on that preflight rule.
 *
 * The corner radius is deliberately NOT part of the base: callers genuinely
 * differ (`rounded-[11px]` on macOS permissions, `rounded-[12px]` on usage and
 * stats tiles, `rounded-[14px]` on the Stats chart card), so
 * each caller passes its radius via `className`. Unifying those radii is a
 * design-authority decision, not a refactoring side effect. No variants. */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("border border-border p-[17px]", className)}
      {...props}
    />
  );
}
