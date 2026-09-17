import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@/lib/terminal/renderer/terminalFont";
import { useActiveTerminalPalette } from "@/lib/theme/themePreference";
import { useStore } from "@/store";

export interface ChatContentTypography {
	readonly fontSize: number;
	readonly lineHeight: number;
	/** The active terminal palette's background — chat and terminal panes of
	 * the same agent read as one surface. */
	readonly background: string;
}

/** Chat follows the shared content appearance settings (설정 › 외관) — the
 * same font-size, line-height, and terminal palette the terminal, editor,
 * and diff views obey. */
export function useChatContentTypography(): ChatContentTypography {
	const fontSize = useStore((s) => s.terminalFontSize);
	const lineHeight = useStore(
		(s) => s.uiPrefs?.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT,
	);
	const palette = useActiveTerminalPalette();
	return { fontSize, lineHeight, background: palette.background };
}
