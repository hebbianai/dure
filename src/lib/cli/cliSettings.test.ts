import { describe, expect, it } from "vitest";

import {
	isUiPrefsKey,
	parseUiPrefsValue,
	planUiPrefsUpdate,
	readUiPrefsSetting,
} from "@/lib/cli/cliSettings";
import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";

const prefs: UiPrefs = {
	...DEFAULT_UI_PREFS,
	themeScheme: { dark: "catppuccin-macchiato" },
};

describe("cliSettings", () => {
	it("accepts only Terminal or Chat as the default Agent pane", () => {
		for (const value of ["terminal", "chat"]) expect(planUiPrefsUpdate("defaultAgentPane", value)).toEqual({ ok: true, value: { defaultAgentPane: value } });
		for (const value of ["unknown", "false", "null"]) expect(planUiPrefsUpdate("defaultAgentPane", value).ok).toBe(false);
	});
	it("reads the whole set when no key is named", () => {
		const result = readUiPrefsSetting(prefs);

		expect(result).toEqual({ ok: true, value: prefs });
	});

	it("reads one key", () => {
		const result = readUiPrefsSetting(prefs, "themeScheme");

		expect(result).toEqual({
			ok: true,
			value: { key: "themeScheme", value: { dark: "catppuccin-macchiato" } },
		});
	});

	it("reports an unset optional key as null, not as missing", () => {
		const result = readUiPrefsSetting(DEFAULT_UI_PREFS, "themeScheme");

		// A script has to tell "not configured" apart from "no such setting".
		expect(result).toEqual({ ok: true, value: { key: "themeScheme", value: null } });
	});

	it("names the known settings when the key is wrong", () => {
		const result = readUiPrefsSetting(prefs, "thmeScheme");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('unknown setting "thmeScheme"');
		expect(result.error).toContain("themeScheme");
	});

	it("takes a bare word as a string so the shell needs no quoting", () => {
		expect(parseUiPrefsValue("dark")).toBe("dark");
	});

	it("takes JSON as JSON", () => {
		expect(parseUiPrefsValue('{"dark":"gruvbox"}')).toEqual({ dark: "gruvbox" });
		expect(parseUiPrefsValue("true")).toBe(true);
		expect(parseUiPrefsValue("18")).toBe(18);
	});

	it("plans an update for a structured key", () => {
		const result = planUiPrefsUpdate("themeScheme", '{"dark":"gruvbox"}');

		expect(result).toEqual({ ok: true, value: { themeScheme: { dark: "gruvbox" } } });
	});

	it("refuses a value of the wrong type where a default declares one", () => {
		const result = planUiPrefsUpdate("theme", "12");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe('setting "theme" expects string, got number');
	});

	it("refuses an unknown key rather than writing it", () => {
		expect(planUiPrefsUpdate("colour", "dark").ok).toBe(false);
	});

	it("knows its own keys", () => {
		expect(isUiPrefsKey("theme")).toBe(true);
		expect(isUiPrefsKey("nope")).toBe(false);
	});
});
