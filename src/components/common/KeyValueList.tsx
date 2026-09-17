import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Semantic key–value description list — the shared `dl` skeleton behind
 * inspector dialogs and settings detail blocks. The list owns the divider
 * rhythm and publishes the label column width as a CSS variable so every
 * row aligns without per-row props; rows own the dt/dd pair. Domain
 * formatting (status dots, copy buttons, code values) stays at the call
 * site as dd children.
 */
export function KeyValueList({
	labelWidth = "7.5rem",
	className,
	children,
}: {
	/** Label column width (any CSS length) — shared by every row. */
	labelWidth?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<dl
			className={cn("divide-y divide-border/50", className)}
			style={{ "--kv-label-width": labelWidth } as CSSProperties}
		>
			{children}
		</dl>
	);
}

/**
 * One dt/dd row inside a KeyValueList. `mono` switches the value into the
 * technical-identifier voice (`font-mono text-[11px]`); `selectable` marks
 * the value as text the user copies by hand (`data-selectable` opts back
 * into native text selection). Value content is a slot — rows never format
 * domain values themselves.
 */
export function KeyValueRow({
	label,
	mono = false,
	selectable = false,
	children,
}: {
	label: ReactNode;
	/** Technical identifier voice: font-mono at the smaller text tier. */
	mono?: boolean;
	/** Marks the value as hand-copyable text (data-selectable). */
	selectable?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="grid grid-cols-[var(--kv-label-width)_minmax(0,1fr)] gap-3 px-3 py-2">
			<dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
			<dd
				data-selectable={selectable ? "" : undefined}
				className={cn(
					"flex min-w-0 items-start gap-2 break-words text-xs leading-5 text-foreground",
					mono && "font-mono text-[11px]",
				)}
			>
				{children}
			</dd>
		</div>
	);
}
