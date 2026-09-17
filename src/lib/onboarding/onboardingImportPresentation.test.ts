import { describe, expect, it } from "vitest";
import {
	compactOnboardingImportCwd,
	onboardingImportPaneTime,
} from "@/lib/onboarding/onboardingImportPresentation";

describe("compactOnboardingImportCwd", () => {
	it("keeps the worktree directory visible for a long absolute path", () => {
		expect(
			compactOnboardingImportCwd(
				"/Users/jwan/AAA/projects/hebbian/HebbianIDE/.worktrees/pixel-fork",
			),
		).toBe("…/HebbianIDE/.worktrees/pixel-fork");
	});

	it("preserves short and root paths", () => {
		expect(compactOnboardingImportCwd("/private/tmp/")).toBe("/private/tmp");
		expect(compactOnboardingImportCwd("/")).toBe("/");
	});
});

describe("onboardingImportPaneTime", () => {
	const now = new Date(2026, 7, 7, 9, 30);
	const at = (
		year: number,
		month: number,
		day: number,
		hour = 14,
		minute = 20,
	) => new Date(year, month, day, hour, minute).getTime() / 1000;

	it("reads today and yesterday as a clock time", () => {
		expect(onboardingImportPaneTime(at(2026, 7, 7, 8, 5), now)).toEqual({
			kind: "today",
			clock: "08:05",
		});
		expect(onboardingImportPaneTime(at(2026, 7, 6), now)).toEqual({
			kind: "yesterday",
			clock: "14:20",
		});
	});

	it("counts calendar days, not elapsed hours", () => {
		// 12시간 전이지만 달력이 넘어갔으므로 "어제"다.
		expect(onboardingImportPaneTime(at(2026, 7, 6, 21, 30), now)).toMatchObject({
			kind: "yesterday",
		});
	});

	it("switches from elapsed days to a date after a week", () => {
		expect(onboardingImportPaneTime(at(2026, 7, 4), now)).toEqual({
			kind: "days",
			days: 3,
		});
		expect(onboardingImportPaneTime(at(2026, 6, 20), now)).toEqual({
			kind: "date",
			month: 7,
			day: 20,
		});
	});
});
