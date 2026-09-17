import { describe, expect, it } from "vitest";
import { TerminalRecoveryPerformanceTracker } from "./terminalRecoveryPerformance";

describe("recovery performance", () => {
	it("counts lifecycle events without retaining detail unless requested", () => {
		let now = 10;
		const tracker = new TerminalRecoveryPerformanceTracker(() => now);
		tracker.record("private-observer", { state: "queued", role: "background" });
		tracker.record("private-observer", { state: "cancelled" });
		now = 20;
		const snapshot = tracker.snapshot();
		expect(snapshot).toMatchObject({
			counts: {
				queued: 1,
				cancelled: 1,
				admitted: 0,
				backendAttachRequests: 0,
				exhausted: 0,
			},
			lastEventAgeMs: 10,
			detail: { state: "disabled", samples: [] },
		});
		expect(JSON.stringify(snapshot)).not.toContain("private");
	});

	it("joins queue waiting and native dispatch only within one exact attachment", () => {
		let now = 10;
		const tracker = new TerminalRecoveryPerformanceTracker(() => now);
		const stop = tracker.startDetailCapture();
		tracker.record("private-a", { state: "queued", role: "background" });
		now = 30;
		tracker.record("private-b", {
			state: "admitted",
			role: "foreground",
			waited: false,
		});
		now = 45;
		tracker.record("private-a", {
			state: "admitted",
			role: "foreground",
			waited: true,
		});
		now = 50;
		tracker.record("private-a", { state: "backend_attach" });
		now = 55;
		tracker.record("private-b", {
			state: "exhausted",
			reason: "reconnect_limit",
		});
		stop();
		const snapshot = tracker.snapshot();
		expect(snapshot.counts).toEqual({
			queued: 1,
			admitted: 2,
			cancelled: 0,
			backendAttachRequests: 1,
			exhausted: 1,
		});
		expect(snapshot.detail).toMatchObject({
			state: "stopped",
			samples: [
				{ attachmentSequence: 1, queueWaitMs: null },
				{ attachmentSequence: 2, queueWaitMs: 0 },
				{ attachmentSequence: 1, queueWaitMs: 35 },
				{ attachmentSequence: 1, admissionToBackendMs: 5 },
				{
					attachmentSequence: 2,
					event: { state: "exhausted", reason: "reconnect_limit" },
				},
			],
		});
		expect(JSON.stringify(snapshot)).not.toContain("private");
	});

	it("leaves a queue interval unobserved when capture starts after enqueue", () => {
		let now = 0;
		const tracker = new TerminalRecoveryPerformanceTracker(() => now);
		tracker.record("queued-before-capture", {
			state: "queued",
			role: "background",
		});
		now = 10;
		tracker.startDetailCapture();
		now = 30;
		tracker.record("queued-before-capture", {
			state: "admitted",
			role: "foreground",
			waited: true,
		});
		expect(tracker.snapshot().detail.samples[0]?.queueWaitMs).toBeNull();
	});

	it("expires after a minute and keeps the sample cap while counters continue", () => {
		let now = 0;
		const tracker = new TerminalRecoveryPerformanceTracker(() => now);
		tracker.startDetailCapture();
		tracker.record("a", {
			state: "admitted",
			role: "foreground",
			waited: false,
		});
		now = 60_000;
		tracker.record("a", { state: "backend_attach" });
		expect(tracker.snapshot().detail).toMatchObject({
			state: "expired",
			samples: [{ event: { state: "admitted" } }],
		});
		tracker.startDetailCapture();
		for (let index = 0; index < 1_000; index += 1)
			tracker.record(`private-${index}`, { state: "backend_attach" });
		const snapshot = tracker.snapshot();
		expect(snapshot.detail.state).toBe("full");
		expect(snapshot.detail.samples).toHaveLength(96);
		expect(snapshot.counts.backendAttachRequests).toBe(1_001);
	});

	it("stopping preserves expired or full capture limits", () => {
		let now = 0;
		const tracker = new TerminalRecoveryPerformanceTracker(() => now);
		const stopExpired = tracker.startDetailCapture();
		now = 60_000;
		stopExpired();
		expect(tracker.snapshot().detail.state).toBe("expired");
		const stopFull = tracker.startDetailCapture();
		for (let index = 0; index < 96; index += 1)
			tracker.record(String(index), { state: "backend_attach" });
		stopFull();
		expect(tracker.snapshot().detail.state).toBe("full");
	});

	it("a retired capture cannot stop a newer capture and snapshots cannot mutate it", () => {
		const tracker = new TerminalRecoveryPerformanceTracker(() => 0);
		const stopOld = tracker.startDetailCapture();
		tracker.record("old", { state: "backend_attach" });
		const oldSnapshot = tracker.snapshot();
		const stopCurrent = tracker.startDetailCapture();
		stopOld();
		tracker.record("a", { state: "backend_attach" });
		const snapshot = tracker.snapshot();
		expect(snapshot.detail.state).toBe("recording");
		expect(snapshot.detail.captureSequence).not.toBe(
			oldSnapshot.detail.captureSequence,
		);
		expect(oldSnapshot.detail.samples).toHaveLength(1);
		snapshot.detail.samples[0]!.atMs = 50;
		expect(tracker.snapshot().detail.samples[0]?.atMs).toBe(0);
		stopCurrent();
		tracker.record("b", { state: "backend_attach" });
		expect(tracker.snapshot().detail.samples).toHaveLength(1);
	});
});
