import {
	loadSettingsPreferences,
	scrollSensitivity,
} from "./settingsPreferences";

export function terminalFontSize(): number {
	return loadSettingsPreferences().fontSize;
}

export function terminalScrollSensitivity(): number {
	return scrollSensitivity(loadSettingsPreferences().scrollSpeed);
}
