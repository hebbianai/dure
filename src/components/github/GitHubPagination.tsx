import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { githubPage, githubPageNumbers } from "@/lib/github/githubPagination";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function GitHubPagination({
	total,
	page,
	disabled,
	compact,
	limited,
	onChange,
}: {
	total: number;
	page: number;
	disabled: boolean;
	compact: boolean;
	limited: boolean;
	onChange: (page: number) => void;
}) {
	const range = githubPage(total, page);
	const rangeLabel = t(
		limited ? "github.pagination.loadedRange" : "github.pagination.range",
		{ start: total ? range.start + 1 : 0, end: range.end, total },
	);
	return (
		// The footer lines up with the rail beside it (owner request 2026-09-10):
		// its controls centre 28px above the pane's bottom edge, where the rail's
		// settings glyph sits (a 36px item over the rail's 10px bottom padding —
		// the two columns share a bottom edge), and its rule crosses at 48px,
		// midway between the settings glyph and the one above it (28 and 68; the
		// glyph centre itself read as the rule cutting the icon — owner call
		// 2026-09-10). The rule runs
		// edge to edge rather than on the sidebar's 12px inset: it closes the
		// column, it does not divide two groups inside it. It was a border-border
		// rule with 6px padding, 10px lower than the settings glyph.
		<footer
			// Fixed geometry, not min-heights: 1px rule, 1px, a 36px nav, 10px —
			// 48px in all, so the rule sits midway between the rail's two glyphs
			// and the nav's centre on the settings glyph line whatever the nav's
			// content measures. (With a min-height the first cut sat ~9px low.)
			className={cn(
				"@container shrink-0 pb-2.5 text-meta text-muted-foreground",
				!limited && "h-[48px]",
			)}
		>
			<div aria-hidden="true" className="mb-px h-px bg-glass-hairline" />
			<nav
				aria-label={t("github.pagination.label")}
				// In the sidebar the arrows hold the two ends and the numbers sit in
				// the middle column, so the text is centred whatever the digits
				// count; one flex run with the range hanging after the next arrow
				// read as pushed right (owner report 2026-09-10).
				className={cn(
					"h-9 min-w-0 items-center overflow-hidden px-3",
					compact
						? "grid grid-cols-[auto_1fr_auto]"
						: "flex justify-center gap-1",
				)}
			>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-label={t("github.pagination.previous")}
					disabled={disabled || range.page === 1}
					onClick={() => onChange(range.page - 1)}
				>
					<ChevronLeft className="size-3.5" />
					{!compact && (
						<span className="hidden @lg:inline">
							{t("github.pagination.previous")}
						</span>
					)}
				</Button>
				{compact ? (
					<span className="flex min-w-0 items-center justify-center gap-2 font-mono tabular-nums">
						<span aria-live="polite" className="shrink-0">
							{range.page} / {range.pageCount}
						</span>
						<span aria-hidden="true">·</span>
						<OverflowRevealText aria-live="polite" text={rangeLabel} />
					</span>
				) : (
					githubPageNumbers(range.page, range.pageCount).map((entry) =>
						typeof entry === "number" ? (
							<Button
								key={entry}
								type="button"
								variant={entry === range.page ? "secondary" : "ghost"}
								size="xs"
								className="min-w-6 font-mono tabular-nums"
								aria-current={entry === range.page ? "page" : undefined}
								aria-label={t("github.pagination.page", { page: entry })}
								disabled={disabled}
								onClick={() => onChange(entry)}
							>
								{entry}
							</Button>
						) : (
							<span key={entry} aria-hidden="true" className="px-1">
								…
							</span>
						),
					)
				)}
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-label={t("github.pagination.next")}
					disabled={disabled || range.page === range.pageCount}
					onClick={() => onChange(range.page + 1)}
				>
					{!compact && (
						<span className="hidden @lg:inline">
							{t("github.pagination.next")}
						</span>
					)}
					<ChevronRight className="size-3.5" />
				</Button>
				{!compact && (
					<span className="shrink-0 px-1 font-mono tabular-nums" aria-live="polite">
						{rangeLabel}
					</span>
				)}
			</nav>
			{limited && (
				<p role="status" className="mt-1 text-center">
					{t("github.pagination.limit")}
				</p>
			)}
		</footer>
	);
}
