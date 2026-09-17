import { type ReactNode, useRef } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useHoverOpenMenu } from "@/lib/ui/hoverOpenMenu";

/** Icon-button menu that opens when the pointer rests on it — click, Enter,
 * and Escape keep working exactly as they do on a plain dropdown.
 *
 * This exists so the hover binding stays one thing. `hoverProps` has to sit on
 * the trigger *and* the content: with it on the trigger alone, the menu closes
 * while the pointer crosses the gap to the surface it just opened. Every
 * hover-opening menu goes through here rather than repeating that pairing.
 *
 * Items are the caller's children — this component owns the trigger, the
 * open/close rule, and lower-right anchoring, not what the menu offers.
 * Down-right from the button (side bottom, align start) is the one rule for
 * every icon-button menu in a pane header — the folder-plus and view-options
 * menus follow it too (owner decision 2026-09-10). */
export function HoverMenuButton({
	title,
	icon,
	triggerClassName,
	contentClassName,
	children,
}: {
	/** Accessible name for the trigger. The tooltip is omitted because the
	 * menu itself is this control's hover disclosure. */
	title: string;
	/** Trigger glyph. Callers swap it for progress state (a spinner) as needed. */
	icon: ReactNode;
	/** Reveal policy and placement live at the call site (hover-reveal, ml-auto…). */
	triggerClassName?: string;
	contentClassName?: string;
	children: ReactNode;
}) {
	const { open, onOpenChange, hoverProps, triggerProps } = useHoverOpenMenu();
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<DropdownMenu open={open} onOpenChange={onOpenChange}>
			{/* triggerProps sits on the Trigger, not on the button inside it:
			    Radix composes a consumer handler ahead of its own toggle and skips
			    the toggle when that handler prevents the default. Through the
			    `asChild` slot the two handlers would merely both run, and the
			    click would still close the menu hover had just opened. */}
			<DropdownMenuTrigger asChild {...triggerProps}>
				<IconButton
					ref={triggerRef}
					title={title}
					showTooltip={false}
					className={triggerClassName}
					{...hoverProps}
				>
					{icon}
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="bottom"
				align="start"
				className={contentClassName}
				{...hoverProps}
				onPointerDownOutside={(event) => {
					// The trigger sits outside the menu's layer, so Radix would read a
					// press on it as an outside press and dismiss the menu the pointer
					// had just opened — before the trigger's own handler could pin it.
					// That press is the toggle's business (pin on the first press,
					// close on the next); only presses elsewhere dismiss.
					const target = event.detail.originalEvent.target;
					if (target instanceof Node && triggerRef.current?.contains(target)) {
						event.preventDefault();
					}
				}}
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
