import { useMemo } from "react";
import { useActiveTerminalPalette } from "@/lib/theme/themePreference";
import type { TerminalPalette } from "@/lib/theme/terminalTheme";
import type { TerminalCanvasTheme } from "./TerminalCanvasRenderer";

export function useTerminalCanvasTheme(): TerminalCanvasTheme {
	const palette = useActiveTerminalPalette();
	return useMemo(() => terminalCanvasTheme(palette), [palette]);
}

function terminalCanvasTheme(
	palette: TerminalPalette,
): TerminalCanvasTheme {
	return {
		background: palette.background,
		foreground: palette.foreground,
		cursor: palette.cursor,
		selectionBackground: palette.selectionBackground,
		indexed: [
			palette.black,
			palette.red,
			palette.green,
			palette.yellow,
			palette.blue,
			palette.magenta,
			palette.cyan,
			palette.white,
			palette.brightBlack,
			palette.brightRed,
			palette.brightGreen,
			palette.brightYellow,
			palette.brightBlue,
			palette.brightMagenta,
			palette.brightCyan,
			palette.brightWhite,
		],
	};
}
