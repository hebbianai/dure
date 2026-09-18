import {
	DEFAULT_UI_PREFS,
	UI_PREFS_KEYS,
	type UiPrefs,
	type UiPrefsKey,
} from "@/lib/settings/uiPrefs";

/**
 * Reading and writing preferences from outside the settings UI.
 *
 * Pure on purpose: the CLI action layer owns the store, this owns what a key
 * and a value are allowed to be. A typo like `set theme 12` fails here with a
 * sentence rather than persisting a number where a mode belongs.
 */

export type CliSettingsOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export function isUiPrefsKey(value: string): value is UiPrefsKey {
	return (UI_PREFS_KEYS as readonly string[]).includes(value);
}

function unknownKey(key: string): string {
	return `unknown setting "${key}" — known settings: ${UI_PREFS_KEYS.join(", ")}`;
}

/** The whole set, or one key. An unset optional key reads as null rather than
 *  disappearing, so a script can tell "not configured" from "no such setting". */
export function readUiPrefsSetting(
	prefs: UiPrefs,
	key?: string,
): CliSettingsOutcome<UiPrefs | { key: UiPrefsKey; value: unknown }> {
	if (key === undefined) return { ok: true, value: prefs };
	if (!isUiPrefsKey(key)) return { ok: false, error: unknownKey(key) };
	return { ok: true, value: { key, value: prefs[key] ?? null } };
}

/** JSON first so objects, arrays, numbers, and booleans all arrive typed;
 *  a bare word that is not valid JSON stays a string, which is what makes
 *  `set theme dark` work without shell quoting. */
export function parseUiPrefsValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	return Array.isArray(value) ? "array" : typeof value;
}

export function planUiPrefsUpdate(
	key: string,
	raw: string,
): CliSettingsOutcome<Partial<UiPrefs>> {
	if (!isUiPrefsKey(key)) return { ok: false, error: unknownKey(key) };
	const value = parseUiPrefsValue(raw);
	if (key === "defaultAgentPane" && value !== "terminal" && value !== "chat") {
		return { ok: false, error: 'setting "defaultAgentPane" expects "terminal" or "chat"' };
	}
	// Only keys with a shipped default carry a type to check against. The
	// optional ones (themeScheme, …) are structured and validated
	// by the store's own normalizer on the way to disk.
	const fallback = (DEFAULT_UI_PREFS as unknown as Record<string, unknown>)[key];
	if (fallback !== undefined && describeType(value) !== describeType(fallback)) {
		return {
			ok: false,
			error: `setting "${key}" expects ${describeType(fallback)}, got ${describeType(value)}`,
		};
	}
	return { ok: true, value: { [key]: value } as Partial<UiPrefs> };
}
