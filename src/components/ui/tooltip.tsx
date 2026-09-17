import type * as React from "react";
import { useState } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { MENU_SIDE_OFFSET } from "@/lib/ui/menuSurface";
import { cn } from "@/lib/utils";

// Hover/focus tooltip primitive over Radix Tooltip, drawn to the design
// system's Tooltip (Design-system-dure 17103:809, 2026-09-09): the primary
// surface (base/primary on base/primary-foreground), 12×6 padding on an 8px
// radius at 13px/18 for `md`, 10×4 on 6px at 11px for `sm`, a 384px maximum,
// a small pointed arrow and no shadow. It had drifted into a rounded-2xl,
// 14px, shadowed "speech bubble" of its own; the owner asked for the comp.
// The label + description form is this codebase's extension (no comp): it
// keeps the md geometry and stacks two lines.
//
// CRITICAL — secondary Tauri windows: PopoutWindow/AgentSessionWindow render
// their React trees into separate documents. Radix Portal defaults to the
// document that mounted the main app, so a portalled tooltip opened from a
// secondary window's tree can land in the wrong document and never become
// visible there. Adopters inside those trees must either pass `container`
// (that window's `document.body`) or set `portalled={false}` on
// TooltipContent to render the bubble in place.
//
// Open animation only, no exit animation — same policy as dropdown-menu.tsx:
// exit-frame re-renders break popper anchor math when the underlying row
// changes state (2026-08-01, three recurrences). Closing unmounts instantly.

/**
 * Default open delay. Short enough to answer an intentional hover without
 * flashing while the pointer merely crosses a toolbar.
 */
const TOOLTIP_DELAY_MS = 100;

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/**
 * Self-providing root: each Tooltip wraps its own TooltipProvider so an
 * incrementally converted `title=` site never crashes on a missing ancestor
 * provider. Trade-off (deliberate, same as upstream shadcn): skip-delay
 * sharing across sibling tooltips needs a region-level TooltipProvider, which
 * this inner provider shadows. A per-tooltip `delayDuration` prop still wins —
 * Radix resolves the root prop before the provider value.
 */
function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = MENU_SIDE_OFFSET,
  portalled = true,
  container,
  description,
  size = "md",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  /** Optional supporting copy rendered below the concise action label. */
  description?: React.ReactNode;
  /** The comp's two sizes: `md` (13px, 12×6) and `sm` (11px, 10×4). */
  size?: "md" | "sm";
  /**
   * Render through a Radix Portal (default). Secondary-window trees
   * (PopoutWindow/AgentSessionWindow — separate documents) must set this to
   * `false` or pass `container`, because the default portal targets the main
   * document's body (see the file comment).
   */
  portalled?: boolean;
  /** Portal target for portalled content, e.g. a secondary window's body. */
  container?: React.ComponentProps<typeof TooltipPrimitive.Portal>["container"];
}) {
  const hasDescription = description !== undefined && description !== null;
  const content = (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        // Unconditional entrance animation: tooltip content only mounts while
        // open, and its data-state is delayed-open/instant-open — never
        // "open" — so the shared `data-open:` variant cannot gate it.
        // Glass in the inverse tone — the system tooltip's bubble: light on a
        // dark theme, dark on a light one. `primary` is that inverse (0.92 on
        // dark, 0.2 on light); over the menus' blur it is frosted, not a
        // solid button (owner call 2026-09-15, on the system bubble). The
        // menus' own dark glass sank into the chrome — the tone must come up.
        // 92%, the dialog's opacity, not the menus' 67 or the first 80: the
        // bubble is small and lands on controls, and at 80 the edge of a
        // button behind it came through the blur as a line across the label
        // (owner report 2026-09-15, the rail's Sessions hint).
        // No shadow, as the comp (17103:809) draws none; the tail keeps the
        // bubble's shape.
        "z-[100] w-fit max-w-96 origin-(--radix-tooltip-content-transform-origin) border border-primary-foreground/10 bg-primary/92 backdrop-blur-[15px] font-normal text-balance text-primary-foreground duration-100 animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-reduce:animate-none",
        size === "sm"
          ? "rounded-sm px-2.5 py-1 text-meta leading-[18px]"
          : "rounded-md px-3 py-1.5 text-xs leading-[18px]",
        hasDescription && "grid gap-0.5 text-left",
        className,
      )}
      {...props}
    >
      {hasDescription ? (
        <>
          <span data-slot="tooltip-label" className="font-medium">
            {children}
          </span>
          <span
            data-slot="tooltip-description"
            className="min-w-0 break-words text-meta leading-3.5 text-primary-foreground/70"
          >
            {description}
          </span>
        </>
      ) : (
        children
      )}
      <TooltipPrimitive.Arrow
        data-slot="tooltip-arrow"
        aria-hidden="true"
        // The comp draws a 10px (md) / 8px (sm) square turned 45°; what shows
        // past the edge is this triangle: 14×7 and 11×6.
        width={size === "sm" ? 11 : 14}
        height={size === "sm" ? 6 : 7}
        // The tail cannot blur; the same 80% of the inverse tone reads as
        // the bubble continuing at 7px.
        className="fill-primary/92"
      />
    </TooltipPrimitive.Content>
  );
  if (!portalled) return content;
  return (
    <TooltipPrimitive.Portal container={container}>
      {content}
    </TooltipPrimitive.Portal>
  );
}

/**
 * The shared tooltip on any element that carried a native `title`: a
 * truncated path, a status glyph, a hand-rolled button. The child is the
 * trigger (Radix `asChild`, so it must take a ref), and the content portals
 * into the child's own document so secondary windows get theirs. Pass
 * nothing and the child renders alone — the common "hint only sometimes"
 * case. The child keeps whatever accessible name it has; this adds a
 * description, not a name (owner call 2026-09-15: one tooltip surface).
 */
function Titled({
  title,
  side,
  size,
  children,
}: {
  title?: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  size?: React.ComponentProps<typeof TooltipContent>["size"];
  children: React.ReactElement;
}) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  if (!title) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild ref={setTrigger}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={side}
        size={size}
        container={trigger?.ownerDocument.body}
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

export { Titled, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
