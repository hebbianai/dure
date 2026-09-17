export type LanguagePreference = "auto" | "ko" | "en";
export type ResolvedLanguage = "ko" | "en";
export type NotificationPreference = "all" | "approvals" | "off";
export type TerminalFontSize = 11 | 12 | 13 | 14 | 15;
export type ScrollSpeed = "slow" | "normal" | "fast";

export interface SettingsPreferences {
	readonly language: LanguagePreference;
	readonly notifications: NotificationPreference;
	readonly fontSize: TerminalFontSize;
	readonly scrollSpeed: ScrollSpeed;
	/** A tick on every tray key press. On by default: the row is a bare switch, with no other cue the feature exists. */
	readonly haptics: boolean;
	/** Face ID before the first input sent while the attached agent waits for an approval. */
	readonly approvalBiometric: boolean;
}

const STORAGE_KEY = "hebbian.settings.v1";

export const DEFAULT_SETTINGS_PREFERENCES = {
	language: "auto",
	notifications: "approvals",
	fontSize: 12,
	scrollSpeed: "normal",
	haptics: true,
	approvalBiometric: false,
} as const satisfies SettingsPreferences;

const SCROLL_SENSITIVITIES = {
	slow: 0.6,
	normal: 1,
	fast: 1.6,
} as const satisfies Readonly<Record<ScrollSpeed, number>>;

export function loadSettingsPreferences(
	storage: Pick<Storage, "getItem"> = localStorage,
): SettingsPreferences {
	let raw: string | null;
	try {
		raw = storage.getItem(STORAGE_KEY);
	} catch {
		return DEFAULT_SETTINGS_PREFERENCES;
	}
	if (!raw) return DEFAULT_SETTINGS_PREFERENCES;

	try {
		const parsed: unknown = JSON.parse(raw);
		return parseSettingsPreferences(parsed) ?? DEFAULT_SETTINGS_PREFERENCES;
	} catch {
		return DEFAULT_SETTINGS_PREFERENCES;
	}
}

export function saveSettingsPreferences(
	preferences: SettingsPreferences,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
	} catch {
		return;
	}
}

export function resolveSettingsLanguage(
	preference: LanguagePreference,
	systemLanguage: string = navigator.language,
): ResolvedLanguage {
	if (preference !== "auto") return preference;
	return /^en(?:-|$)/i.test(systemLanguage) ? "en" : "ko";
}

export function scrollSensitivity(speed: ScrollSpeed): number {
	return SCROLL_SENSITIVITIES[speed];
}

function parseSettingsPreferences(value: unknown): SettingsPreferences | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("language" in value) ||
		!("notifications" in value) ||
		!("fontSize" in value) ||
		!("scrollSpeed" in value) ||
		!isLanguagePreference(value.language) ||
		!isNotificationPreference(value.notifications) ||
		!isTerminalFontSize(value.fontSize) ||
		!isScrollSpeed(value.scrollSpeed)
	) {
		return null;
	}

	// The switches arrived after the first records were written. An absent key
	// is its default; a present non-boolean is a broken record, like any other
	// wrong value. Requiring the key would null every installed phone's record
	// on the update that added it and reset language, font and scroll speed.
	const haptics = optionalBoolean(value, "haptics", DEFAULT_SETTINGS_PREFERENCES.haptics);
	const approvalBiometric = optionalBoolean(
		value,
		"approvalBiometric",
		DEFAULT_SETTINGS_PREFERENCES.approvalBiometric,
	);
	if (haptics === null || approvalBiometric === null) return null;

	return {
		language: value.language,
		notifications: value.notifications,
		fontSize: value.fontSize,
		scrollSpeed: value.scrollSpeed,
		haptics,
		approvalBiometric,
	};
}

function optionalBoolean(record: object, key: string, fallback: boolean): boolean | null {
	if (!(key in record)) return fallback;
	const value: unknown = (record as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : null;
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
	return value === "auto" || value === "ko" || value === "en";
}

function isNotificationPreference(
	value: unknown,
): value is NotificationPreference {
	return value === "all" || value === "approvals" || value === "off";
}

function isTerminalFontSize(value: unknown): value is TerminalFontSize {
	return (
		value === 11 || value === 12 || value === 13 || value === 14 || value === 15
	);
}

function isScrollSpeed(value: unknown): value is ScrollSpeed {
	return value === "slow" || value === "normal" || value === "fast";
}
