import { describe, expect, it } from "vitest";
import { composeEnglishTranslations } from "@/lib/settings/englishTranslationRegistry";

describe("composeEnglishTranslations", () => {
	it("combines independently owned feature dictionaries", () => {
		const translations = composeEnglishTranslations([
			{ name: "workspace", translations: { 파일: "Files" } },
			{ name: "settings", translations: { 설정: "Settings" } },
		]);

		expect(translations).toEqual({ 파일: "Files", 설정: "Settings" });
		expect(Object.isFrozen(translations)).toBe(true);
	});

	it("fails deterministically when fragments define the same key", () => {
		expect(() =>
			composeEnglishTranslations([
				{ name: "workspace", translations: { 닫기: "Close" } },
				{ name: "terminal", translations: { 닫기: "Dismiss" } },
			]),
		).toThrowError(
			'Duplicate English translation key "닫기" in "workspace" and "terminal"',
		);
	});
});
