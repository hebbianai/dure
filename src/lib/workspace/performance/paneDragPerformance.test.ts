import { describe, expect, it, vi } from "vitest";
import type { PostPaintOptions } from "@/lib/scheduling/postPaint";
import {
	MAX_PANE_DRAG_SAMPLES,
	PaneDragPerformanceTracker,
} from "./paneDragPerformance";

function fixture() {
	let now = 100;
	const probes: Array<{
		callback: () => void;
		options: PostPaintOptions;
		cancel: ReturnType<typeof vi.fn>;
	}> = [];
	const tracker = new PaneDragPerformanceTracker(
		() => now,
		(callback, options) => {
			const cancel = vi.fn();
			probes.push({ callback, options, cancel });
			return cancel;
		},
		1_000,
	);
	return {
		tracker,
		probes,
		at: (time: number) => {
			now = time;
		},
	};
}

const event = (timeStamp = 90, isTrusted = true, type = "dragover") =>
	({ timeStamp, isTrusted, type }) as DragEvent;

describe("pane drag timing", () => {
	it("separates event age, task delay, first frame and post-frame task", () => {
		const f = fixture();
		f.tracker.record(event());
		f.at(120);
		f.probes[0].options.onTask?.();
		f.at(260);
		f.probes[0].options.onFrame?.();
		f.at(270);
		f.probes[0].callback();
		expect(f.tracker.snapshot()).toEqual({
			timeOriginMs: 1_000,
			startedAt: null,
			recent: [
				{
					sequence: 1,
					eventType: "dragover",
					receivedAt: 100,
					trusted: true,
					eventAgeMs: 10,
					receivedGapMs: null,
					receiptToTaskMs: 20,
					receiptToFrameMs: 160,
					receiptToPostFrameTaskMs: 170,
					frameProbe: "complete",
					frameProbeSequence: 1,
				},
			],
		});
	});

	it("bounds probes to one and does not mistake coalescing for zero latency", () => {
		const f = fixture();
		const first = event();
		f.tracker.record(first);
		f.tracker.record(first);
		f.at(108);
		f.tracker.record(event(105));
		expect(f.probes).toHaveLength(1);
		expect(f.tracker.snapshot().recent[1]).toMatchObject({
			receivedGapMs: 8,
			eventAgeMs: 3,
			frameProbe: "coalesced",
			frameProbeSequence: 1,
			receiptToFrameMs: null,
			receiptToPostFrameTaskMs: null,
		});
		f.at(120);
		f.probes[0].options.onFrame?.();
		f.probes[0].callback();
		f.tracker.record(event());
		expect(f.probes).toHaveLength(2);
	});

	it.each([event(90, false), event(0), event(200), event(Number.NaN)])(
		"keeps unavailable browser event age unknown",
		(value) => {
			const f = fixture();
			f.tracker.record(value);
			expect(f.tracker.snapshot().recent[0].eventAgeMs).toBeNull();
		},
	);

	it("cancels pending probes and rejects callbacks from a previous gesture", () => {
		const f = fixture();
		f.tracker.record(event());
		f.tracker.end();
		expect(f.probes[0].cancel).toHaveBeenCalledOnce();
		expect(f.tracker.snapshot().recent[0].frameProbe).toBe("cancelled");
		f.at(200);
		f.tracker.record(event());
		f.probes[0].options.onTask?.();
		f.probes[0].options.onFrame?.();
		f.probes[0].callback();
		expect(f.tracker.snapshot().recent).toHaveLength(1);
		expect(f.tracker.snapshot().recent[0]).toMatchObject({
			receivedAt: 200,
			frameProbe: "pending",
			receiptToFrameMs: null,
		});
	});

	it("retains drag entry and a bounded recent tail without exposing mutable samples", () => {
		const f = fixture();
		for (let index = 0; index < 500; index++) {
			f.at(100 + index);
			f.tracker.record(event());
		}
		const snapshot = f.tracker.snapshot();
		expect(snapshot.recent).toHaveLength(MAX_PANE_DRAG_SAMPLES);
		expect(snapshot.recent[0].sequence).toBe(1);
		expect(snapshot.recent[snapshot.recent.length - 1].sequence).toBe(500);
		snapshot.recent[0].receivedAt = 0;
		expect(f.tracker.snapshot().recent[0].receivedAt).toBe(100);
	});

	it("does not create probes for dragleave or dragend", () => {
		const f = fixture();
		f.tracker.record(event(90, true, "dragleave"));
		f.tracker.record(event(90, true, "dragend"));
		expect(f.probes).toHaveLength(0);
	});

	it("keeps a later stalled probe visible when newer events fill the history", () => {
		const f = fixture();
		f.tracker.record(event());
		f.probes[0].options.onFrame?.();
		f.probes[0].callback();
		for (let index = 0; index < 500; index++) {
			f.at(101 + index);
			f.tracker.record(event());
		}
		const samples = f.tracker.snapshot().recent;
		expect(samples).toHaveLength(MAX_PANE_DRAG_SAMPLES);
		expect(samples[0].sequence).toBe(1);
		expect(samples[1]).toMatchObject({ sequence: 2, frameProbe: "pending" });
		expect(samples[samples.length - 1].sequence).toBe(501);
	});

	it("keeps local drag start and first entry on the same clock", () => {
		const f = fixture();
		f.tracker.begin();
		f.at(1_375);
		f.tracker.record(event(1_370, true, "dragenter"));
		const snapshot = f.tracker.snapshot();
		expect(snapshot.startedAt).toBe(100);
		expect(snapshot.recent[0]).toMatchObject({
			eventType: "dragenter",
			receivedAt: 1_375,
			eventAgeMs: 5,
		});
	});
});
