import type { ComponentProps, ReactNode } from "react";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { cn } from "@/lib/utils";

/** The chevron's 12px and its 6px gap: the body hangs under the label at
 * this inset, and a label that does not fold starts here too (PaneLabel), so
 * labels share one edge with the chevron in the gutter before it. */
export const DISCLOSURE_INDENT = "pl-[18px]";

/** Whether the fold is open: the caller's, with `open` and `onOpenChange`
 * together, or the fold's own, starting at `defaultOpen`, which
 * `onOpenChange` may still follow. */
export type DisclosureOpenState =
	| {
			open: boolean;
			defaultOpen?: never;
			onOpenChange: (open: boolean) => void;
	  }
	| {
			open?: never;
			defaultOpen?: boolean;
			onOpenChange?: (open: boolean) => void;
	  };

/** The one collapsible row: a native `<details>` whose summary is the fold
 * chevron (DisclosureChevron, 12px, right → down) before a medium label, with
 * the body hanging under the label at the chevron's width. Five sites drew
 * this over the browser's own marker with their own summary styles — an
 * underlined link, a bordered card, plain muted text (owner audit
 * 2026-09-13). ChatToolBurst's tool folds already wore the chevron and keep
 * their own row anatomy. Native open/close is kept: a ref and `.open` behave
 * as on `<details>`, and the native toggle reaches the caller as
 * `onOpenChange`.
 *
 * `size`: "xs" (12/18 — panes, cards, dialogs) or "meta" (11/15 — the
 * sidebar tier). `bodyClassName` replaces the body's default 4px gap. */
export function Disclosure({
	label,
	size = "xs",
	className,
	bodyClassName,
	open,
	defaultOpen,
	onOpenChange,
	children,
	...props
}: Omit<ComponentProps<"details">, "className" | "open" | "onToggle"> &
	DisclosureOpenState & {
		label: ReactNode;
		size?: "xs" | "meta";
		className?: string;
		bodyClassName?: string;
	}) {
	return (
		<details
			className={cn(
				"group/disclosure",
				size === "meta" ? "text-meta" : "text-xs",
				className,
			)}
			// A fold of its own takes `defaultOpen` once; React writes the
			// attribute again only when the value changes.
			open={open ?? defaultOpen}
			onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
			{...props}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
				<DisclosureChevron className="group-open/disclosure:rotate-90" />
				<span className="min-w-0 truncate">{label}</span>
			</summary>
			<div className={cn("mt-1", DISCLOSURE_INDENT, bodyClassName)}>
				{children}
			</div>
		</details>
	);
}
