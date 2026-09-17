import { describe, expect, it } from "vitest";
import {
	parseOnboardingImportPaneDrag,
	serializeOnboardingImportPaneDrag,
} from "@/lib/onboarding/onboardingImportDrag";

describe("onboarding import pane drag payload", () => {
	it("round-trips one exact pane and source desktop", () => {
		expect(
			parseOnboardingImportPaneDrag(
				serializeOnboardingImportPaneDrag("codex:session", "desktop:source"),
			),
		).toEqual({
			schemaVersion: 1,
			paneKey: "codex:session",
			fromDesktopId: "desktop:source",
		});
	});

	it.each([
		"",
		"not-json",
		"{}",
		'{"schemaVersion":2,"paneKey":"pane","fromDesktopId":"desktop"}',
		'{"schemaVersion":1,"paneKey":"","fromDesktopId":"desktop"}',
	])("rejects an invalid or unsupported payload", (raw) => {
		expect(parseOnboardingImportPaneDrag(raw)).toBeNull();
	});
});
