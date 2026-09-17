import { MoreHorizontal } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Square icon button (24px box + 14px icon) — promoted from the sidebar
 * section-header primitive (`SidebarIconButton`), which the whole app already
 * reused (title bars, panes, dialogs). `title` is mandatory and always mirrored
 * to `aria-label`, so a nameless icon button cannot exist at the type level;
 * callers may suppress the shared tooltip when hover already opens a menu.
 * `onClick` may be omitted: wrapped in a Radix `asChild` trigger, the trigger
 * injects its handler and state props through `...rest`. Size/hover variations
 * stay at the call site via `className` (tailwind-merge resolves conflicts). */
export function IconButton({
  title,
  showTooltip = true,
  pressed,
  className,
  ...rest
}: {
  /** Accessible name — always rendered as `aria-label`. */
  title: string;
  /** Show the shared tooltip. Menus and controls that already
   * disclose themselves on hover turn this off to avoid competing surfaces. */
  showTooltip?: boolean;
  /** Toggle buttons (pin, filter, …) pass their state here: it is mirrored to
   * `aria-pressed` and, while true, keeps the canonical pressed tint
   * `text-foreground` (the PaneChrome/SourceControlWindow idiom). Omit for
   * plain action buttons — no `aria-pressed` attribute is rendered then. */
  pressed?: boolean;
  className?: string;
  // ComponentProps rather than ButtonHTMLAttributes so a caller's `ref`
  // (React 19 passes it as a prop) reaches the button — HoverMenuButton needs
  // the trigger node to tell its own press from an outside press.
} & Omit<React.ComponentProps<"button">, "title" | "className">) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const button = (
    <button
      type="button"
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-glass-tint-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
        pressed && "text-foreground",
        className,
      )}
      // An empty title also prevents an ancestor's native tooltip from showing.
      title=""
      aria-label={title}
      aria-pressed={pressed}
      {...rest}
    />
  );
  if (!showTooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild ref={setTrigger}>
        {button}
      </TooltipTrigger>
      {/* Pane controls also render in secondary-window documents. */}
      <TooltipContent container={trigger?.ownerDocument.body}>
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

/** Row overflow-menu trigger — the 22px ⋯ button that list rows put in their
 * hover-revealed menu slot. Always rendered as a `DropdownMenuTrigger asChild`
 * child: Radix injects `onClick`/`aria-*`/`data-state` through `...rest`, and
 * the open menu keeps the button tinted via `data-[state=open]`. */
export function RowMenuButton({
  title,
  className,
  ...rest
}: {
  /** Accessible name and shared tooltip label. */
  title: string;
  className?: string;
} & Omit<React.ComponentProps<"button">, "title" | "className">) {
  return (
    <IconButton
      title={title}
      className={cn(
        "size-[22px] hover:text-muted-foreground data-[state=open]:bg-foreground/10",
        className,
      )}
      {...rest}
    >
      <MoreHorizontal className="size-3.5" />
    </IconButton>
  );
}
