// Shared dialog-presentational shapes. Per-domain state machines,
// close-while-busy policies, and generation fences stay at the callers.
// Copy is injected by callers except for CleanupSummaryLine, whose canonical
// count copy belongs to the shared common locale fragment.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Muted in-dialog notice for caller-owned progress or caveat copy. */
export function DialogNotice({
	className,
	children,
}: {
	className?: string;
	children?: ReactNode;
}) {
	return (
		<p
			className={cn(
				"rounded border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground",
				className,
			)}
		>
			{children}
		</p>
	);
}

/**
 * Compact bordered error chip for dialog bodies. Deliberately distinct from
 * inside a dialog the message sits between header and content, so it stays a
 * quieter text-only chip.
 */

/**
 * Bordered scroll list of cleanup candidates. Row layout stays at the caller:
 * renderItem returns the full <li> (including its key). With no items it
 * renders emptyText, or nothing when the caller has no empty copy.
 */
export function CandidateList<T>({
	items,
	renderItem,
	emptyText,
	maxHeightClass = "max-h-44",
	className,
}: {
	items: readonly T[];
	renderItem: (item: T) => ReactNode;
	emptyText?: ReactNode;
	maxHeightClass?: string;
	className?: string;
}) {
	if (items.length === 0) {
		return emptyText ? (
			<p className="text-xs text-muted-foreground">{emptyText}</p>
		) : null;
	}
	return (
		<ul
			className={cn(
				"space-y-1 overflow-auto rounded border border-border/60 p-2",
				maxHeightClass,
				className,
			)}
		>
			{items.map(renderItem)}
		</ul>
	);
}

/** One pre-mapped skipped row — domain reason vocabularies stay at callers. */
export interface ReceiptSkipRow {
	key: string;
	name: string;
	reasonLabel: string;
	message?: string;
}

/**
 * Post-execution receipt: the cleaned-count line plus the muted skipped list.
 * The count copy differs per domain, so the caller formats it via
 * cleanedLabel. Extra domain sections (e.g. a failed list) come as children.
 */
export function ReceiptSummary({
	cleanedCount,
	cleanedLabel,
	skipped,
	skippedHeading,
	children,
}: {
	cleanedCount: number;
	cleanedLabel: (cleanedCount: number) => ReactNode;
	skipped: readonly ReceiptSkipRow[];
	/** Optional muted heading above the skipped list. */
	skippedHeading?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="space-y-2 text-xs">
			<p>{cleanedLabel(cleanedCount)}</p>
			{skipped.length > 0 && (
				<>
					{skippedHeading !== undefined && (
						<p className="text-muted-foreground">{skippedHeading}</p>
					)}
					<ul className="max-h-32 space-y-1 overflow-auto text-[10px] text-muted-foreground">
						{skipped.map((row) => (
							<li key={row.key}>
								{row.name} — {row.reasonLabel}
								{row.message ? ` (${row.message})` : ""}
							</li>
						))}
					</ul>
				</>
			)}
			{children}
		</div>
	);
}

/** Canonical cleanable-versus-protected count summary. */
export function CleanupSummaryLine({
	cleanable,
	protectedCount,
	className,
}: {
	cleanable: number;
	protectedCount: number;
	className?: string;
}) {
	return (
		<p className={className}>
			{t("common.cleanup.summary", { n: cleanable, m: protectedCount })}
		</p>
	);
}
