import type { ComponentProps, ReactNode } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";

/** One line of a pane under a hairline, at the pane's 12px inset in the muted
 * tier: a part's label (`as="h3"`) or, through FoldLine, its fold. Every part
 * below a pane's content shares this box, so they read as one rhythm. */
export function PaneLine({
	as: Tag = "section",
	className,
	...props
}: Omit<ComponentProps<"section">, "ref"> & { as?: "section" | "h3" }) {
	return (
		<Tag
			className={cn(
				"shrink-0 border-t border-glass-hairline px-3 py-1.5 text-xs text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}

/** A part of a pane folded to its PaneLine: a status dot and the words that
 * sum the part up, unfolding to its rows, which scroll within
 * `bodyClassName`'s cap. The fold keeps its own open state unless the caller
 * passes `open` with `onOpenChange`. */
export function FoldLine({
	dot,
	summary,
	open,
	onOpenChange,
	bodyClassName,
	children,
	...section
}: Omit<ComponentProps<"section">, "ref" | "children"> & {
	dot: ReactNode;
	summary: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	bodyClassName?: string;
	children: ReactNode;
}) {
	return (
		<PaneLine {...section}>
			<Disclosure
				open={open}
				onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
				label={
					<span className="inline-flex items-center gap-2 font-normal text-muted-foreground">
						{dot}
						{summary}
					</span>
				}
				bodyClassName={bodyClassName}
			>
				{children}
			</Disclosure>
		</PaneLine>
	);
}
