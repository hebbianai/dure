import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The 12px disclosure chevron every collapsible row shares. Two glyph pairs:
 * `"right-down"` (default) points right when closed and rotates down when
 * open; `"down-up"` points down when closed and rotates up when open — for
 * expanders whose content collapses back upward (ThemeSchemePicker idiom).
 * Decorative (`aria-hidden`) — the wrapping toggle owns the accessible state
 * (`aria-expanded`). Color/size deviations stay at the call site via
 * `className`. */
/** `hint`: the chevron shows only while its row (a `group/label`) is hovered
 *  or holds focus, and keeps its 12px slot at rest so nothing shifts — the
 *  Claude desktop sidebar idiom for folder rows (owner call 2026-09-10; it
 *  stands after the row's count, at the end). */
export function DisclosureChevron({
  open,
  orientation = "right-down",
  hint = false,
  className,
}: {
  open?: boolean;
  orientation?: "right-down" | "down-up";
  hint?: boolean;
  className?: string;
}) {
  const Chevron = orientation === "down-up" ? ChevronDown : ChevronRight;
  return (
    <Chevron
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0 text-muted-foreground transition-transform",
        open && (orientation === "down-up" ? "rotate-180" : "rotate-90"),
        // Key the ancestor outside :where to avoid WebKit-wide focus invalidation
        // (#775). Zero the target specificity to retain the group variant cascade.
        hint &&
          String.raw`invisible group-hover/label:visible [.group\/label:focus-within_:where(&)]:visible`,
        className,
      )}
    />
  );
}
