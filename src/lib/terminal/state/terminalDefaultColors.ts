import type { TerminalPalette } from "@/lib/theme/terminalTheme";

export interface TerminalDefaultColors {
	readonly foregroundRgb: number;
	readonly backgroundRgb: number;
}

const SRGB_HEX = /^#[0-9a-f]{6}$/i;

function parseSrgb(value: string): number {
	if (SRGB_HEX.test(value)) {
		return Number.parseInt(value.slice(1), 16);
	}
	throw new Error(`terminal default color must be #rrggbb: ${value}`);
}

/** Converts presentation defaults into the provider-neutral 24-bit values
 * used only to answer terminal OSC 10/11 queries. */
export function terminalDefaultColors(
	palette: Pick<TerminalPalette, "foreground" | "background">,
): TerminalDefaultColors {
	return {
		foregroundRgb: parseSrgb(palette.foreground),
		backgroundRgb: parseSrgb(palette.background),
	};
}
