// What the terminal find bar does with keys and with the Host's answer. The
// Host owns the search (it holds history the WebView never had); this module
// only decides which chord opens the bar, what a key inside it means, and how
// the frame's find summary reads. Kept pure so vitest can drive real chords.

import {
	FindStatus,
	type ViewportFind,
} from "@/contracts/terminalStateProtocol";
import {
	type KeyChord,
	matchesChord,
	type ShortcutOverrides,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import type { DesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import type { TerminalKeyEvent } from "./terminalKeyBindings";

const TERMINAL_FIND_SHORTCUT_ID = "term-find";
/** Typing pauses this long before the Host searches again. */
export const TERMINAL_FIND_DEBOUNCE_MS = 150;

/**
 * Whether a keydown in a focused terminal opens the find bar.
 *
 * The catalog chord is ⌘F. On macOS that is Command+F. Elsewhere bare Ctrl+F
 * belongs to the shell (readline's forward-char), so the terminal chord adds
 * Shift — the same rule as copy (⌘C ↔ Ctrl+Shift+C).
 */
export function isTerminalFindShortcut(
	event: TerminalKeyEvent,
	overrides: ShortcutOverrides,
	platform: DesktopPlatform,
): boolean {
	const chord = shortcutChord(TERMINAL_FIND_SHORTCUT_ID, overrides);
	if (!chord) return false;
	if (platform === "macos") {
		return event.metaKey && !event.ctrlKey && matchesChord(chord, event);
	}
	return (
		event.ctrlKey && !event.metaKey && matchesChord(terminalChord(chord), event)
	);
}

function terminalChord(chord: KeyChord): KeyChord {
	return chord.mod ? { ...chord, shift: true } : chord;
}

export type TerminalFindBarKeyAction = "older" | "newer" | "close";

/** Enter walks up through older output, Shift+Enter back down; Escape closes. */
export function terminalFindBarKeyAction(event: {
	readonly key: string;
	readonly shiftKey: boolean;
	readonly isComposing?: boolean;
}): TerminalFindBarKeyAction | null {
	if (event.isComposing) return null;
	if (event.key === "Escape") return "close";
	if (event.key === "Enter") return event.shiftKey ? "newer" : "older";
	return null;
}

export type TerminalFindSummary =
	| { readonly kind: "idle" }
	| { readonly kind: "searching" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "invalid" }
	| { readonly kind: "none"; readonly complete: boolean }
	| {
			readonly kind: "matched";
			readonly current: number;
			readonly total: number;
			readonly complete: boolean;
	  };

/**
 * What the bar shows for the newest frame. `pending` covers a typed query the
 * Host has not answered yet, so a stale count never describes a new query.
 */
export function terminalFindSummary(input: {
	readonly supported: boolean;
	readonly query: string;
	readonly pending: boolean;
	readonly find: ViewportFind | undefined;
}): TerminalFindSummary {
	if (!input.supported) return { kind: "unsupported" };
	if (input.query === "") return { kind: "idle" };
	if (input.pending || !input.find) return { kind: "searching" };
	switch (input.find.status) {
		case FindStatus.MATCHED:
			return {
				kind: "matched",
				current: input.find.currentMatch,
				total: input.find.matchCount,
				complete: input.find.matchCountComplete,
			};
		case FindStatus.NO_MATCH:
			return { kind: "none", complete: input.find.matchCountComplete };
		case FindStatus.INVALID_PATTERN:
			return { kind: "invalid" };
		default:
			return { kind: "searching" };
	}
}

export interface TerminalFindHighlightBox {
	readonly key: string;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly current: boolean;
}

/** Pixel boxes for the frame's highlight segments at the painted metrics. */
export function terminalFindHighlightBoxes(
	find: ViewportFind | undefined,
	metrics: { readonly cellWidth: number; readonly rowHeight: number } | null,
): TerminalFindHighlightBox[] {
	if (!find || !metrics || find.status !== FindStatus.MATCHED) return [];
	return find.highlights.map((highlight) => ({
		key: `${highlight.row}:${highlight.startColumn}`,
		left: highlight.startColumn * metrics.cellWidth,
		top: highlight.row * metrics.rowHeight,
		width: (highlight.endColumn - highlight.startColumn) * metrics.cellWidth,
		height: metrics.rowHeight,
		current: highlight.current,
	}));
}
