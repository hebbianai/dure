import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS_PREFERENCES,
	loadSettingsPreferences,
	resolveSettingsLanguage,
	saveSettingsPreferences,
	scrollSensitivity,
} from "./settingsPreferences";

describe("settingsPreferences", () => {
	it("uses the shipped defaults when storage is missing or invalid", () => {
		expect(loadSettingsPreferences({ getItem: () => null })).toEqual(
			DEFAULT_SETTINGS_PREFERENCES,
		);
		expect(loadSettingsPreferences({ getItem: () => "not-json" })).toEqual(
			DEFAULT_SETTINGS_PREFERENCES,
		);
		expect(
			loadSettingsPreferences({
				getItem: () =>
					JSON.stringify({
						language: "fr",
						notifications: "approvals",
						fontSize: 12,
						scrollSpeed: "normal",
					}),
			}),
		).toEqual(DEFAULT_SETTINGS_PREFERENCES);
	});

	it("ships haptics on and the approval Face ID gate off", () => {
		expect(DEFAULT_SETTINGS_PREFERENCES).toMatchObject({
			haptics: true,
			approvalBiometric: false,
		});
	});

	/**
	 * A record written before the two switches existed keeps what it has and
	 * gets the defaults for the rest. Nulling it would reset every installed
	 * phone's language, font and scroll speed on the update that added them.
	 */
	it("fills absent switches with their defaults without dropping the rest", () => {
		expect(
			loadSettingsPreferences({
				getItem: () =>
					JSON.stringify({
						language: "ko",
						notifications: "all",
						fontSize: 14,
						scrollSpeed: "slow",
					}),
			}),
		).toEqual({
			language: "ko",
			notifications: "all",
			fontSize: 14,
			scrollSpeed: "slow",
			haptics: true,
			approvalBiometric: false,
		});
	});

	it("rejects a switch that is present but not a boolean", () => {
		expect(
			loadSettingsPreferences({
				getItem: () =>
					JSON.stringify({
						language: "ko",
						notifications: "all",
						fontSize: 14,
						scrollSpeed: "slow",
						haptics: "yes",
					}),
			}),
		).toEqual(DEFAULT_SETTINGS_PREFERENCES);
	});

	it("round-trips one validated preference record", () => {
		let written = "";
		saveSettingsPreferences(
			{
				language: "en",
				notifications: "off",
				fontSize: 15,
				scrollSpeed: "fast",
				haptics: false,
				approvalBiometric: true,
			},
			{ setItem: (_key, value) => (written = value) },
		);

		expect(loadSettingsPreferences({ getItem: () => written })).toEqual({
			language: "en",
			notifications: "off",
			fontSize: 15,
			scrollSpeed: "fast",
			haptics: false,
			approvalBiometric: true,
		});
	});

	it("resolves automatic language to English only for an English system locale", () => {
		expect(resolveSettingsLanguage("auto", "en-US")).toBe("en");
		expect(resolveSettingsLanguage("auto", "ja-JP")).toBe("ko");
		expect(resolveSettingsLanguage("ko", "en-US")).toBe("ko");
		expect(resolveSettingsLanguage("en", "ko-KR")).toBe("en");
	});

	it("maps slow, normal, and fast scrolling to increasing sensitivities", () => {
		expect(scrollSensitivity("slow")).toBeLessThan(scrollSensitivity("normal"));
		expect(scrollSensitivity("normal")).toBe(1);
		expect(scrollSensitivity("fast")).toBeGreaterThan(
			scrollSensitivity("normal"),
		);
	});
});
