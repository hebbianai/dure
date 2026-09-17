interface StructuredTerminalCompositionOverlayProps {
	readonly text: string;
	readonly left: number;
	readonly top: number;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
}

/** One browser-owned preedit projection. The containing terminal remains the
 * clip authority, while this bound keeps the overlay box itself inside it. */
export function StructuredTerminalCompositionOverlay({
	text,
	left,
	top,
	fontFamily,
	fontSize,
	lineHeight,
}: StructuredTerminalCompositionOverlayProps) {
	return (
		<div
			data-testid="structured-terminal-composition"
			aria-hidden="true"
			className="pointer-events-none absolute z-10 box-border overflow-hidden whitespace-pre border-b border-current"
			style={{
				left,
				top,
				color: "var(--terminal-cursor-cell-foreground)",
				backgroundColor: "var(--terminal-cursor-cell-background)",
				maxWidth: `calc(100% - ${Math.max(0, left)}px)`,
				fontFamily,
				fontSize,
				fontFeatureSettings: '"liga" 0, "calt" 0',
				fontKerning: "none",
				fontVariantLigatures: "none",
				letterSpacing: "normal",
				lineHeight,
				textOverflow: "clip",
			}}
		>
			{text}
		</div>
	);
}
