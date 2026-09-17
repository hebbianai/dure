import { afterEach, describe, expect, it } from "vitest";
import {
	type FrameBudgetHost,
	FrameBudgetScheduler,
	resetFrameBudgetSchedulerForTest,
} from "@/lib/scheduling/frameBudgetScheduler";
import { TerminalInputLatencyTracker } from "./terminalInputLatency";

class SchedulerHost implements FrameBudgetHost {
	nowMs = 0;
	private nextHandle = 1;
	private readonly frames = new Map<number, (frameStartMs: number) => void>();

	now() {
		return this.nowMs;
	}

	requestFrame(callback: (frameStartMs: number) => void) {
		const handle = this.nextHandle++;
		this.frames.set(handle, callback);
		return handle;
	}

	cancelFrame(handle: number) {
		this.frames.delete(handle);
	}

	setTimeout() {
		return this.nextHandle++;
	}

	clearTimeout() {}

	pumpFrame(advanceMs: number) {
		this.nowMs += advanceMs;
		const callbacks = [...this.frames.values()];
		this.frames.clear();
		for (const callback of callbacks) callback(this.nowMs);
	}
}

afterEach(() => {
	resetFrameBudgetSchedulerForTest();
});

describe("TerminalInputLatencyTracker", () => {
	it("records keydown, Host receipt, and the first later output paint", () => {
		let now = 10;
		const tracker = new TerminalInputLatencyTracker({ now: () => now });
		tracker.noteKeydown("terminal-1");
		now = 12;
		tracker.markSemanticKeydown("terminal-1");
		now = 13;
		tracker.markSemanticKeydownDecision("terminal-1");
		now = 14;
		const handle = tracker.beginInput({
			terminalId: "terminal-1",
			desktopId: "desktop-1",
		});
		expect(handle).toBeDefined();
		now = 15;
		tracker.markTransportConfirmation(handle!);

		// Native output and receipt use independent async channels. The provider
		// paint may legitimately win the race and is joined when the receipt lands.
		now = 16;
		tracker.markHostInputOutputTiming(handle!, {
			inputAcceptedToOutputMs: 5.25,
			outputToProjectionStartMs: 2.75,
		});
		now = 18;
		tracker.markOutputReceived("terminal-1");
		tracker.markProjectionCommitted(handle!, {
			projectionStartedAt: 18.5,
			projectionCommittedAt: 19.5,
		});
		const paint = tracker.claimOutputPaint("terminal-1");
		expect(paint).toEqual(handle);
		now = 19.5;
		tracker.markOutputTask(paint!);
		now = 19.75;
		tracker.markOutputFrame(paint!);
		now = 20;
		tracker.markOutputPaint(paint!);
		expect(tracker.snapshot().inFlightCount).toBe(1);
		now = 31;
		tracker.markHostReceipt(handle!);

		expect(tracker.snapshot()).toEqual({
			inFlightCount: 0,
			samples: [
				{
					sequence: 1,
					terminalId: "terminal-1",
					desktopId: "desktop-1",
					source: "keydown",
					startedAt: 10,
					dispatchMs: 4,
					captureToSemanticHandlerMs: 2,
					semanticHandlerToDispatchMs: 2,
					semanticHandlerToDecisionMs: 1,
					semanticDecisionToDispatchMs: 1,
					replacementChainActiveAtCapture: false,
					transportConfirmationMs: 5,
					hostReceiptBeforeTransportConfirmation: false,
					hostReceiptMs: 21,
					successorOutputObserved: true,
					hostInputAcceptedToOutputMs: 5.25,
					hostOutputToProjectionStartMs: 2.75,
					outputReceivedMs: 8,
					projectionStartedMs: 8.5,
					projectionCommittedMs: 9.5,
					echoTaskMs: 9.5,
					echoFrameMs: 9.75,
					frameBeforeTask: false,
					taskToFrameSchedulerActivity: {
						unitsRun: 0,
						msSpent: 0,
						terminalPresentationUnitsRun: 0,
						terminalPresentationMsSpent: 0,
					},
					echoPaintMs: 10,
					receiptToOutputMs: 0,
					outputToPaintMs: 2,
					receiptToPaintMs: 0,
					outcome: "complete",
				},
			],
		});
	});

	it("does not reuse an unconsumed semantic decision for later native text", () => {
		let now = 10;
		const tracker = new TerminalInputLatencyTracker({
			now: () => now,
			sampleIntervalMs: 0,
		});
		tracker.noteKeydown("terminal-1");
		now = 11;
		tracker.markSemanticKeydown("terminal-1");
		now = 12;
		tracker.markSemanticKeydownDecision("terminal-1");
		now = 13;
		tracker.noteNativeTextInput("terminal-1");
		now = 14;
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		expect(handle).toBeDefined();
		tracker.markFailed(handle!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			captureToSemanticHandlerMs: null,
			semanticHandlerToDecisionMs: null,
			semanticHandlerToDispatchMs: null,
			source: "input",
		});
	});

	it("records when frame eligibility wins before shared task availability", () => {
		const host = new SchedulerHost();
		const scheduler = new FrameBudgetScheduler(host);
		resetFrameBudgetSchedulerForTest(scheduler);
		const tracker = new TerminalInputLatencyTracker({ now: () => host.nowMs });
		tracker.noteInput("terminal-1");
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markHostReceipt(handle!);
		host.nowMs = 1;
		tracker.markOutputReceived("terminal-1");
		tracker.markProjectionCommitted(handle!, {
			projectionStartedAt: 2,
			projectionCommittedAt: 3,
		});
		const paint = tracker.claimOutputPaint("terminal-1");
		host.nowMs = 5;
		tracker.markOutputFrame(paint!);
		scheduler.schedule(
			"reveal",
			() => {
				host.nowMs += 2;
			},
			"structured-terminal-presentation.foreground",
		);
		host.pumpFrame(1);
		tracker.markOutputTask(paint!);
		host.nowMs += 1;
		tracker.markOutputPaint(paint!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			echoTaskMs: 8,
			echoFrameMs: 5,
			frameBeforeTask: true,
			taskToFrameSchedulerActivity: null,
		});
	});

	it("attributes scheduler work that runs between the existing task and frame probes", () => {
		const host = new SchedulerHost();
		const scheduler = new FrameBudgetScheduler(host);
		resetFrameBudgetSchedulerForTest(scheduler);
		const tracker = new TerminalInputLatencyTracker({ now: () => host.nowMs });
		tracker.noteInput("terminal-1");
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markHostReceipt(handle!);
		host.nowMs = 1;
		tracker.markOutputReceived("terminal-1");
		tracker.markProjectionCommitted(handle!, {
			projectionStartedAt: 2,
			projectionCommittedAt: 3,
		});
		const paint = tracker.claimOutputPaint("terminal-1");
		host.nowMs = 4;
		tracker.markOutputTask(paint!);

		scheduler.schedule(
			"reveal",
			() => {
				host.nowMs += 2;
			},
			"structured-terminal-presentation.foreground",
		);
		scheduler.schedule(
			"reveal",
			() => {
				host.nowMs += 3;
			},
			"workspace-reveal",
		);
		host.pumpFrame(1);
		tracker.markOutputFrame(paint!);
		host.nowMs += 1;
		tracker.markOutputPaint(paint!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			frameBeforeTask: false,
			taskToFrameSchedulerActivity: {
				unitsRun: 2,
				msSpent: 5,
				terminalPresentationUnitsRun: 1,
				terminalPresentationMsSpent: 2,
			},
		});
	});

	it("does not join counters across scheduler generations after a reset", () => {
		const host = new SchedulerHost();
		const scheduler = new FrameBudgetScheduler(host);
		resetFrameBudgetSchedulerForTest(scheduler);
		scheduler.schedule(
			"reveal",
			() => {
				host.nowMs += 2;
			},
			"structured-terminal-presentation.foreground",
		);
		host.pumpFrame(1);

		const tracker = new TerminalInputLatencyTracker({ now: () => host.nowMs });
		tracker.noteInput("terminal-1");
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markHostReceipt(handle!);
		host.nowMs += 1;
		tracker.markOutputReceived("terminal-1");
		const paint = tracker.claimOutputPaint("terminal-1");
		tracker.markOutputTask(paint!);

		const replacement = new FrameBudgetScheduler(host);
		resetFrameBudgetSchedulerForTest(replacement);
		replacement.schedule(
			"reveal",
			() => {
				host.nowMs += 3;
			},
			"structured-terminal-presentation.foreground",
		);
		host.pumpFrame(1);
		tracker.markOutputFrame(paint!);
		host.nowMs += 1;
		tracker.markOutputPaint(paint!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			frameBeforeTask: false,
			taskToFrameSchedulerActivity: null,
		});
	});

	it("records replacement activity at capture without changing the semantic send", () => {
		let now = 10;
		const tracker = new TerminalInputLatencyTracker({ now: () => now });
		tracker.noteKeydown("terminal-1", true);
		now = 14;
		tracker.markSemanticKeydown("terminal-1");
		now = 17;
		tracker.markSemanticKeydownDecision("terminal-1");
		now = 19;
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markFailed(handle!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			captureToSemanticHandlerMs: 4,
			dispatchMs: 9,
			replacementChainActiveAtCapture: true,
			semanticDecisionToDispatchMs: 2,
			semanticHandlerToDecisionMs: 3,
			semanticHandlerToDispatchMs: 5,
			source: "keydown",
		});
	});

	it("ignores renderer commits until input-following output is delivered", () => {
		let now = 0;
		const tracker = new TerminalInputLatencyTracker({ now: () => now });
		tracker.noteInput("terminal-1");
		const handle = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markHostReceipt(handle!);
		tracker.markProjectionCommitted(handle!, {
			projectionStartedAt: 1,
			projectionCommittedAt: 2,
		});

		expect(tracker.claimOutputPaint("terminal-1")).toBeUndefined();
		expect(tracker.snapshot().inFlightCount).toBe(1);
		now = 5;
		tracker.markOutputReceived("terminal-1");
		tracker.markProjectionCommitted(handle!, {
			projectionStartedAt: 4,
			projectionCommittedAt: 6,
		});
		const paint = tracker.claimOutputPaint("terminal-1");
		expect(paint).toEqual(handle);
		now = 7;
		tracker.markOutputPaint(paint!);
		expect(tracker.snapshot().samples[0]).toMatchObject({
			projectionStartedMs: null,
			projectionCommittedMs: null,
			echoTaskMs: null,
			echoFrameMs: null,
			frameBeforeTask: null,
			taskToFrameSchedulerActivity: null,
			echoPaintMs: 7,
		});
	});

	it("rate limits confirmed inputs and consumes stale keydown candidates", () => {
		let now = 0;
		const tracker = new TerminalInputLatencyTracker({
			now: () => now,
			sampleIntervalMs: 250,
		});
		tracker.noteKeydown("terminal-1");
		const first = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markHostReceipt(first!);
		tracker.markOutputReceived("terminal-1");
		const firstPaint = tracker.claimOutputPaint("terminal-1");
		now = 10;
		tracker.markOutputPaint(firstPaint!);

		now = 100;
		tracker.noteKeydown("terminal-1");
		expect(tracker.beginInput({ terminalId: "terminal-1" })).toBeUndefined();
		now = 260;
		tracker.noteInput("terminal-1");
		const second = tracker.beginInput({ terminalId: "terminal-1" });
		expect(second).toBeDefined();
		tracker.markHostReceipt(second!);
		tracker.markOutputReceived("terminal-1");
		const secondPaint = tracker.claimOutputPaint("terminal-1");
		now = 270;
		tracker.markOutputPaint(secondPaint!);

		expect(tracker.snapshot().samples.map((sample) => sample.source)).toEqual([
			"keydown",
			"input",
		]);
	});

	it("lets an explicit QA input bypass the sampling throttle", () => {
		let now = 0;
		const tracker = new TerminalInputLatencyTracker({
			now: () => now,
			sampleIntervalMs: 250,
		});
		tracker.noteInput("terminal-1");
		const first = tracker.beginInput({ terminalId: "terminal-1" });
		tracker.markFailed(first!);

		now = 10;
		tracker.noteInput("terminal-1", { bypassSamplingThrottle: true });
		expect(tracker.beginInput({ terminalId: "terminal-1" })).toEqual({
			sequence: 2,
			terminalId: "terminal-1",
		});
	});

	it("times out abandoned samples and bounds retained history", () => {
		let now = 0;
		const tracker = new TerminalInputLatencyTracker({
			now: () => now,
			sampleIntervalMs: 0,
			timeoutMs: 50,
			maxSamples: 2,
		});

		for (let index = 0; index < 3; index += 1) {
			tracker.noteInput(`terminal-${index}`);
			tracker.beginInput({ terminalId: `terminal-${index}` });
			now += 60;
			tracker.snapshot();
		}

		const snapshot = tracker.snapshot();
		expect(snapshot.inFlightCount).toBe(0);
		expect(snapshot.samples).toHaveLength(2);
		expect(snapshot.samples.map((sample) => sample.sequence)).toEqual([2, 3]);
		expect(
			snapshot.samples.every((sample) => sample.outcome === "timed_out"),
		).toBe(true);
	});

	it("records failed confirmation without retaining input bytes", () => {
		const tracker = new TerminalInputLatencyTracker({ sampleIntervalMs: 0 });
		tracker.noteInput("terminal-secret");
		const handle = tracker.beginInput({ terminalId: "terminal-secret" });
		tracker.markFailed(handle!);

		expect(tracker.snapshot().samples[0]).toMatchObject({
			terminalId: "terminal-secret",
			outcome: "failed",
			hostReceiptMs: null,
			hostInputAcceptedToOutputMs: null,
			hostOutputToProjectionStartMs: null,
			outputReceivedMs: null,
			projectionStartedMs: null,
			projectionCommittedMs: null,
			echoTaskMs: null,
			echoFrameMs: null,
			frameBeforeTask: null,
			taskToFrameSchedulerActivity: null,
			echoPaintMs: null,
			receiptToOutputMs: null,
			outputToPaintMs: null,
		});
		expect(JSON.stringify(tracker.snapshot())).not.toContain("inputBytes");
	});

	it("starts a clean phase after benchmark warm-up", () => {
		const tracker = new TerminalInputLatencyTracker({ sampleIntervalMs: 0 });
		tracker.noteInput("terminal-1");
		tracker.beginInput({ terminalId: "terminal-1" });

		tracker.resetMeasurements();
		expect(tracker.snapshot()).toEqual({ inFlightCount: 0, samples: [] });
		tracker.noteInput("terminal-1");
		expect(tracker.beginInput({ terminalId: "terminal-1" })).toEqual({
			sequence: 1,
			terminalId: "terminal-1",
		});
	});

	it("ignores xterm protocol replies without a DOM user intent", () => {
		const tracker = new TerminalInputLatencyTracker({ sampleIntervalMs: 0 });

		expect(
			tracker.beginInput({
				terminalId: "terminal-protocol",
				desktopId: "desktop-1",
			}),
		).toBeUndefined();
		expect(tracker.snapshot()).toEqual({
			inFlightCount: 0,
			samples: [],
		});
	});

	it("accepts an explicit semantic input boundary without weakening protocol filtering", () => {
		const tracker = new TerminalInputLatencyTracker({ sampleIntervalMs: 0 });

		expect(
			tracker.beginInput({
				terminalId: "structured-terminal",
				fallbackSource: "input",
			}),
		).toEqual({ sequence: 1, terminalId: "structured-terminal" });
		expect(tracker.snapshot().inFlightCount).toBe(1);
	});
});
