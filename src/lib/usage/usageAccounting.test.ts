import { describe, expect, it } from "vitest";
import {
	normalizeTokenUsage,
	summarizeUsage,
	type UsageTokenCounts,
} from "@/lib/usage/usageAccounting";

function usage(overrides: Partial<UsageTokenCounts> = {}): UsageTokenCounts {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		...overrides,
	};
}

describe("normalizeTokenUsage", () => {
	it("treats Codex cached input as a subset instead of charging it twice", () => {
		expect(
			normalizeTokenUsage(
				usage({
					input: 1_000,
					output: 50,
					cacheRead: 900,
					total: 1_050,
				}),
				"input-subset",
			),
		).toEqual({
			input: 100,
			output: 50,
			cacheRead: 900,
			cacheWrite: 0,
			activityTotal: 150,
			processedTotal: 1_050,
		});
	});

	it("preserves Claude's disjoint cache counters", () => {
		expect(
			normalizeTokenUsage(
				usage({
					input: 100,
					output: 20,
					cacheRead: 80,
					cacheWrite: 10,
					total: 210,
				}),
				"disjoint",
			),
		).toEqual({
			input: 100,
			output: 20,
			cacheRead: 80,
			cacheWrite: 10,
			activityTotal: 210,
			processedTotal: 210,
		});
	});

	it("clamps malformed Codex cache counters to their containing input", () => {
		expect(
			normalizeTokenUsage(
				usage({
					input: 100,
					output: 20,
					cacheRead: 500,
				}),
				"input-subset",
			),
		).toEqual({
			input: 0,
			output: 20,
			cacheRead: 100,
			cacheWrite: 0,
			activityTotal: 20,
			processedTotal: 120,
		});
	});
});

describe("summarizeUsage", () => {
	it("combines providers without overlapping Codex input and cache", () => {
		expect(
			summarizeUsage([
				normalizeTokenUsage(
					usage({
						input: 100,
						output: 20,
						cacheRead: 80,
						cacheWrite: 10,
						total: 210,
					}),
					"disjoint",
				),
				normalizeTokenUsage(
					usage({
						input: 1_000,
						output: 50,
						cacheRead: 900,
						total: 1_050,
					}),
					"input-subset",
				),
			]),
		).toEqual({
			input: 200,
			output: 70,
			cacheRead: 980,
			cacheWrite: 10,
			activityTotal: 360,
			processedTotal: 1_260,
		});
	});
});
