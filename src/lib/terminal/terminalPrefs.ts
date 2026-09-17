export interface TerminalPrefs {
	/** Copy a completed terminal selection to the system clipboard. */
	copyOnSelect: boolean;
	/** Allow terminal programs to write the system clipboard through OSC 52. */
	osc52: boolean;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
	copyOnSelect: true,
	osc52: true,
};

/** Parse persisted preferences once and discard fields from retired renderers. */
export function normalizeTerminalPrefs(value: unknown): TerminalPrefs {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	return {
		copyOnSelect:
			typeof record.copyOnSelect === "boolean"
				? record.copyOnSelect
				: DEFAULT_TERMINAL_PREFS.copyOnSelect,
		osc52:
			typeof record.osc52 === "boolean"
				? record.osc52
				: DEFAULT_TERMINAL_PREFS.osc52,
	};
}
