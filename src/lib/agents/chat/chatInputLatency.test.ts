import { describe, expect, it } from "vitest";
import { ChatInputLatencyTracker } from "./chatInputLatency";

describe("ChatInputLatencyTracker", () => {
	it("records draft input through React commit and paint without prompt data", () => {
		let now = 10;
		const tracker = new ChatInputLatencyTracker({ now: () => now });
		const handle = tracker.beginInput();

		now = 13;
		expect(tracker.markCommitted(handle!)).toBe(true);
		now = 19;
		tracker.markFrame(handle!);
		now = 31;
		tracker.markPaint(handle!);

		expect(tracker.snapshot()).toEqual({
			inFlightCount: 0,
			latestSampleAgeMs: 0,
			samples: [
				{
					sequence: 1,
					startedAt: 10,
					commitMs: 3,
					commitToFrameMs: 6,
					frameToPostPaintMs: 12,
					paintMs: 21,
					commitToPaintMs: 18,
					outcome: "complete",
				},
			],
		});
		expect(JSON.stringify(tracker.snapshot())).not.toContain("prompt");
	});

	it("samples rapid input at a bounded rate and reports sample age", () => {
		let now = 0;
		const tracker = new ChatInputLatencyTracker({ now: () => now });
		const first = tracker.beginInput();
		tracker.markCommitted(first!);
		now = 8;
		tracker.markFrame(first!);
		now = 16;
		tracker.markPaint(first!);

		now = 100;
		expect(tracker.beginInput()).toBeUndefined();
		now = 266;
		expect(tracker.beginInput()).toEqual({ sequence: 2 });
		expect(tracker.snapshot().latestSampleAgeMs).toBe(250);
	});

	it("times out abandoned samples and bounds retained history", () => {
		let now = 0;
		const tracker = new ChatInputLatencyTracker({
			now: () => now,
			sampleIntervalMs: 0,
			timeoutMs: 10,
			maxSamples: 2,
		});

		for (let index = 0; index < 3; index += 1) {
			tracker.beginInput();
			now += 11;
			tracker.snapshot();
		}

		expect(tracker.snapshot()).toMatchObject({
			inFlightCount: 0,
			samples: [
				{ sequence: 2, outcome: "timed_out" },
				{ sequence: 3, outcome: "timed_out" },
			],
		});
	});

	it("cancels an unmounted composer without manufacturing a sample", () => {
		const tracker = new ChatInputLatencyTracker({ sampleIntervalMs: 0 });
		const handle = tracker.beginInput();
		tracker.cancel(handle!);

		expect(tracker.snapshot()).toEqual({
			inFlightCount: 0,
			latestSampleAgeMs: null,
			samples: [],
		});
	});
});
