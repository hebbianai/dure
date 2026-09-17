import { describe, expect, it, vi } from "vitest";
import { createManagedRefreshTiming } from "./managedRefreshTiming";

describe("request-local Refresh timing", () => {
	it("keeps monotonic elapsed time separate from wall-clock correlation", () => {
		let now = 100;
		const unixMs = vi.fn(() => 1000);
		const timing = createManagedRefreshTiming({ now: () => now, unixMs });
		now = 125;
		timing.mark("invoke.start");
		now = 200;
		timing.mark("invoke.received");
		expect(timing.snapshot()).toEqual({
			schemaVersion: 1,
			clock: "webview_monotonic",
			startedAtUnixMs: 1000,
			totalMs: 100,
			checkpoints: [
				{ phase: "action.start", elapsedMs: 0 },
				{ phase: "invoke.start", elapsedMs: 25 },
				{ phase: "invoke.received", elapsedMs: 100 },
			],
			truncated: false,
		});
		expect(unixMs).toHaveBeenCalledOnce();
	});

	it("bounds repeated checkpoints without polling or further clock reads", () => {
		const now = vi.fn(() => 100);
		const timing = createManagedRefreshTiming({ now, unixMs: () => 1000 });
		for (let index = 0; index < 100; index++) timing.mark("invoke.start");
		expect(now).toHaveBeenCalledTimes(32);
		expect(timing.snapshot()).toMatchObject({ truncated: true });
		expect(timing.snapshot().checkpoints).toHaveLength(32);
	});

	it("keeps concurrent requests and returned snapshots independent", () => {
		let now = 100;
		const clock = { now: () => now, unixMs: () => 1000 };
		const first = createManagedRefreshTiming(clock);
		now = 150;
		const second = createManagedRefreshTiming(clock);
		first.mark("action.complete");
		const snapshot = first.snapshot();
		snapshot.checkpoints[0].elapsedMs = 999;
		snapshot.checkpoints.length = 0;
		expect(first.snapshot().checkpoints).toEqual([
			{ phase: "action.start", elapsedMs: 0 },
			{ phase: "action.complete", elapsedMs: 50 },
		]);
		expect(second.snapshot()).toMatchObject({
			totalMs: 0,
			checkpoints: [{ phase: "action.start", elapsedMs: 0 }],
		});
	});
});
