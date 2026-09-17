import { describe, expect, it } from "vitest";
import { summarizeLatencyStats } from "./latencyStats";

describe("summarizeLatencyStats", () => {
	it("summarizes unsorted durations with nearest-rank percentiles", () => {
		expect(summarizeLatencyStats([9, 1, 5, 3])).toEqual({
			count: 4,
			median: 3,
			p95: 9,
			max: 9,
		});
	});

	it("keeps an empty distribution explicit", () => {
		expect(summarizeLatencyStats([])).toEqual({
			count: 0,
			median: null,
			p95: null,
			max: null,
		});
	});
});
