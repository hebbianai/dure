import {
	type CellStyle,
	ColorKind,
	type TerminalColor,
} from "@/contracts/terminalStateProtocol";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";

export interface TerminalCellColors {
	readonly foreground: string;
	readonly background: string;
}

interface TerminalColorSources extends TerminalCellColors {
	readonly indexed: (index: number) => string | undefined;
}

export function terminalCursorCell(
	installed: InstalledTerminalViewportFrame,
):
	| { readonly text: string; readonly style: CellStyle | undefined }
	| undefined {
	const cursor = installed.frame.cursor;
	if (!cursor) return undefined;
	const tables = installed.frame.tables;
	const fallbackStyle = tables?.styles[cursor.styleIndex];
	const row = installed.frame.rows[cursor.row];
	if (!row || !tables) return { text: " ", style: fallbackStyle };

	let currentColumn = 0;
	for (const cell of row.cells) {
		const grapheme = tables.graphemes[cell.graphemeIndex];
		if (!grapheme) continue;
		const nextColumn = currentColumn + grapheme.displayWidth;
		if (cursor.column >= currentColumn && cursor.column < nextColumn) {
			return {
				text: grapheme.text || " ",
				style: tables.styles[cell.styleIndex] ?? fallbackStyle,
			};
		}
		currentColumn = nextColumn;
	}
	return { text: " ", style: fallbackStyle };
}

export function terminalCellColors(
	style: CellStyle | undefined,
	sources: TerminalColorSources,
): TerminalCellColors {
	if (!style) {
		return {
			foreground: sources.foreground,
			background: sources.background,
		};
	}
	let foreground = terminalColor(style.foreground, sources.foreground, sources);
	let background = terminalColor(style.background, sources.background, sources);
	if (hasStyleFlag(style.flags, 4)) {
		[foreground, background] = [background, foreground];
	}
	return {
		foreground: hasStyleFlag(style.flags, 5) ? "transparent" : foreground,
		background,
	};
}

function terminalColor(
	color: TerminalColor | undefined,
	fallback: string,
	sources: TerminalColorSources,
): string {
	switch (color?.kind) {
		case ColorKind.PALETTE:
			return sources.indexed(color.value) ?? fallback;
		case ColorKind.RGB:
			return `#${(color.value & 0xffffff).toString(16).padStart(6, "0")}`;
		default:
			return fallback;
	}
}

function hasStyleFlag(flags: bigint, bit: number): boolean {
	return (flags & (1n << BigInt(bit))) !== 0n;
}
