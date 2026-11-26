import {
	type TerminalCellMetrics,
	type TerminalCellSpan,
	terminalCellSpanBox,
} from "@/lib/terminal/geometry/terminalCellSpan";

/** Underlines the link under the pointer while the link modifier is held, at
 * the bottom of each row it covers, like an underline cursor. */
export function StructuredTerminalLinkUnderline({
	spans,
	metrics,
	color,
}: {
	spans: readonly TerminalCellSpan[] | null;
	metrics: TerminalCellMetrics | null;
	/** The terminal palette's foreground. */
	color: string;
}) {
	if (!spans || spans.length === 0 || !metrics) return null;
	return (
		<div
			aria-hidden
			data-testid="structured-terminal-link-underline"
			className="pointer-events-none absolute inset-0"
		>
			{spans.map((span) => {
				const box = terminalCellSpanBox(span, metrics);
				return (
					<div
						key={box.key}
						className="absolute"
						style={{
							left: box.left,
							top: box.top + box.height - 1,
							width: box.width,
							height: 1,
							backgroundColor: color,
						}}
					/>
				);
			})}
		</div>
	);
}
