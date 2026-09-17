import { describe, expect, it } from "vitest";
import { en } from "@/locales/en";
import { onboardingImportEnglishFallback } from "@/locales/onboardingImportEnglishFallback";

describe("onboardingImportEnglishFallback", () => {
	it("matches the canonical English onboarding copy", () => {
		const canonical: Record<string, string> = en;
		expect(
			Object.entries(onboardingImportEnglishFallback).filter(
				([source, translation]) => canonical[source] !== translation,
			),
		).toEqual([]);
	});
});
