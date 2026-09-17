import {
	type CellStyle,
	ColorKind,
	type TerminalColor,
	UnderlineKind,
} from "@/contracts/terminalStateProtocol";

export function applyTerminalViewportCellStyle(
	element: HTMLElement,
	style: CellStyle,
	overrides: {
		readonly backgroundColor?: string;
		readonly color?: string;
	} = {},
): void {
	let foreground = terminalViewportColorCss(
		style.foreground,
		"var(--terminal-fg)",
	);
	const defaultBackground = "var(--terminal-bg)";
	let background = terminalViewportColorCss(style.background, defaultBackground);
	if (hasTerminalViewportStyleFlag(style.flags, 4)) {
		[foreground, background] = [background, foreground];
	}
	// A cell on the default background paints nothing of its own: the host
	// paints that colour once, with the surface alpha folded in, and an
	// opaque copy per cell would hide it (2026-09-09). An inverse cell whose
	// background became the default *foreground* keeps its colour.
	if (background === defaultBackground) background = "transparent";
	const invisible = hasTerminalViewportStyleFlag(style.flags, 5);
	element.style.color = invisible
		? "transparent"
		: (overrides.color ?? foreground);
	element.style.backgroundColor = overrides.backgroundColor ?? background;
	element.style.fontWeight = hasTerminalViewportStyleFlag(style.flags, 0)
		? "700"
		: "400";
	element.style.fontStyle = hasTerminalViewportStyleFlag(style.flags, 2)
		? "italic"
		: "normal";
	element.style.opacity = hasTerminalViewportStyleFlag(style.flags, 1)
		? "0.55"
		: "1";
	element.classList.toggle(
		"terminal-viewport-blink",
		hasTerminalViewportStyleFlag(style.flags, 3),
	);
	const decorationLines: string[] = [];
	if (
		style.underline !== UnderlineKind.NONE &&
		style.underline !== UnderlineKind.UNSPECIFIED
	) {
		decorationLines.push("underline");
	}
	if (hasTerminalViewportStyleFlag(style.flags, 6)) {
		decorationLines.push("line-through");
	}
	if (hasTerminalViewportStyleFlag(style.flags, 7)) {
		decorationLines.push("overline");
	}
	element.style.textDecorationLine = decorationLines.join(" ");
	element.style.textDecorationStyle = underlineStyle(style.underline);
	element.style.textDecorationColor = invisible
		? "transparent"
		: terminalViewportColorCss(style.underlineColor, foreground);
}

export function hasTerminalViewportStyleFlag(
	flags: bigint,
	bit: number,
): boolean {
	return (flags & (1n << BigInt(bit))) !== 0n;
}

export function terminalViewportColorCss(
	color: TerminalColor | undefined,
	fallback: string,
): string {
	switch (color?.kind) {
		case ColorKind.PALETTE:
			return `var(--terminal-color-${color.value})`;
		case ColorKind.RGB:
			return terminalViewportCssHex(color.value) ?? fallback;
		default:
			return fallback;
	}
}

/** Host terminal colors are content, not Dure chrome tokens. */
export function terminalViewportCssHex(
	rgb: number | undefined,
): string | undefined {
	if (rgb === undefined) return undefined;
	return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

function underlineStyle(kind: UnderlineKind): string {
	switch (kind) {
		case UnderlineKind.DOUBLE:
			return "double";
		case UnderlineKind.CURLY:
			return "wavy";
		case UnderlineKind.DOTTED:
			return "dotted";
		case UnderlineKind.DASHED:
			return "dashed";
		default:
			return "solid";
	}
}
