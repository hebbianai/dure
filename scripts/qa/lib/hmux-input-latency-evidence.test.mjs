import { describe, expect, test } from "vitest";
import {
	assertAppGenerationFence,
	assertDirectInputEvidence,
	assertFocusedWindowFence,
	assertNativeKeydownEvidence,
	captureAppGenerationFence,
	captureFocusedWindowFence,
} from "./hmux-input-latency-evidence.mjs";

const labels = { target: "window-a", sibling: "window-b" };

describe("Hmux native keydown evidence", () => {
	test("keeps direct input separate from one complete native keydown trace", () => {
		const baseline = receipt(input(), input());
		const direct = receipt(input(), input({ inputCompleted: 1 }));

		expect(assertDirectInputEvidence(baseline, direct, labels)).toEqual({
			completedInputSamples: 1,
		});
		expect(() =>
			assertNativeKeydownEvidence(baseline, direct, labels),
		).toThrow("expected exactly one");

		const native = receipt(
			input({ keydownCompleted: 1, recent: [completeKeydownSample()] }),
			input({ inputCompleted: 1 }),
		);
		expect(assertNativeKeydownEvidence(direct, native, labels)).toEqual(
			completeKeydownSample(),
		);
	});

	test("rejects an incomplete trace or input in the sibling window", () => {
		const baseline = receipt(input(), input());
		const incomplete = completeKeydownSample();
		incomplete.hostReceiptMs = null;
		const native = receipt(
			input({ keydownCompleted: 1, recent: [incomplete] }),
			input({ inputCompleted: 1 }),
		);

		expect(() =>
			assertNativeKeydownEvidence(baseline, native, labels),
		).toThrow("window-b source=input changed unexpectedly");

		const targetOnly = receipt(
			input({ keydownCompleted: 1, recent: [incomplete] }),
			input(),
		);
		expect(() =>
			assertNativeKeydownEvidence(baseline, targetOnly, labels),
		).toThrow("trace is incomplete");

		const accountingGap = completeKeydownSample();
		accountingGap.dispatchMs = 40;
		const outOfOrder = receipt(
			input({ keydownCompleted: 1, recent: [accountingGap] }),
			input(),
		);
		expect(() =>
			assertNativeKeydownEvidence(baseline, outOfOrder, labels),
		).toThrow("trace is out of order");
	});

	test("rejects a receipt outside the terminal-input projection", () => {
		const baseline = receipt(input(), input());
		const direct = receipt(input(), input({ inputCompleted: 1 }));

		expect(() =>
			assertDirectInputEvidence(
				{ ...baseline, projection: "full" },
				direct,
				labels,
			),
		).toThrow("multi-window terminal input report is incomplete");
		expect(() =>
			assertDirectInputEvidence(
				{
					...baseline,
					report: { ...baseline.report, projection: "full" },
				},
				direct,
				labels,
			),
		).toThrow("multi-window terminal input report is incomplete");
	});

	test.each([
		["transport before dispatch", { transportConfirmationMs: 3 }],
		["Host ordering flag drift", { hostReceiptBeforeTransportConfirmation: true }],
		["frame ordering flag drift", { frameBeforeTask: true }],
		["receipt-to-output drift", { receiptToOutputMs: 3 }],
		["output-to-paint drift", { outputToPaintMs: 7 }],
		["receipt-to-paint drift", { receiptToPaintMs: 9 }],
	])("rejects internally inconsistent trace: %s", (_name, mutation) => {
		const baseline = receipt(input(), input());
		const sample = { ...completeKeydownSample(), ...mutation };
		const native = receipt(
			input({ keydownCompleted: 1, recent: [sample] }),
			input(),
		);

		expect(() =>
			assertNativeKeydownEvidence(baseline, native, labels),
		).toThrow("trace is out of order");
	});

	test("accepts output and paint observed before the Host receipt callback", () => {
		const baseline = receipt(input(), input());
		const sample = {
			...completeKeydownSample(),
			hostReceiptMs: 21,
			outputReceivedMs: 8,
			projectionStartedMs: 9,
			projectionCommittedMs: 9,
			echoTaskMs: 10,
			echoFrameMs: 10,
			echoPaintMs: 10,
			receiptToOutputMs: 0,
			outputToPaintMs: 2,
			receiptToPaintMs: 0,
		};
		const native = receipt(
			input({ keydownCompleted: 1, recent: [sample] }),
			input(),
		);

		expect(assertNativeKeydownEvidence(baseline, native, labels)).toEqual(
			sample,
		);
	});
});

describe("Hmux native keydown identity fences", () => {
	test("preserves the app generation and focused WebView attachment", () => {
		const descriptor = appIdentity();
		const ping = { ...descriptor, token: undefined, ok: true };
		const appFence = captureAppGenerationFence({
			descriptor,
			ping,
			processGroupId: 41,
			processIdentity: "kernel-start-v3:macos:boot:42",
		});
		assertAppGenerationFence(
			appFence,
			descriptor,
			ping,
			"kernel-start-v3:macos:boot:42",
		);

		const status = focusStatus();
		const windowFence = captureFocusedWindowFence(status);
		assertFocusedWindowFence(windowFence, status);
		expect(() =>
			captureFocusedWindowFence({
				...status,
				windows: {
					...status.windows,
					a: { ...status.windows.a, terminalInputFocused: false },
				},
			}),
		).toThrow("focus fence is incomplete");
		expect(() =>
			assertFocusedWindowFence(windowFence, {
				...status,
				windows: {
					...status.windows,
					a: {
						...status.windows.a,
						latestSurfaceAttachmentId: "attachment-2",
					},
				},
			}),
		).toThrow("attachmentId changed");
	});
});

function receipt(target, sibling) {
	return {
		ok: true,
		projection: "terminal-input",
		report: {
			projection: "terminal-input",
			complete: true,
			missingWindowLabels: [],
			windows: [
				{ windowLabel: labels.target, terminalInput: target },
				{ windowLabel: labels.sibling, terminalInput: sibling },
			],
		},
	};
}

function input({ inputCompleted = 0, keydownCompleted = 0, recent = [] } = {}) {
	return {
		bySource: {
			keydown: sourceCounts(keydownCompleted),
			input: sourceCounts(inputCompleted),
		},
		inFlightCount: 0,
		recent,
	};
}

function sourceCounts(completedCount) {
	return {
		completedCount,
		correlationSupersededCount: 0,
		failedCount: 0,
		timedOutCount: 0,
		timedOutAfterSuccessorOutputCount: 0,
		timedOutWithoutSuccessorCount: 0,
	};
}

function completeKeydownSample() {
	return {
		sequence: 1,
		terminalId: "terminal-a",
		desktopId: "desktop-1",
		source: "keydown",
		startedAt: 100,
		dispatchMs: 4,
		captureToSemanticHandlerMs: 1,
		semanticHandlerToDispatchMs: 3,
		semanticHandlerToDecisionMs: 1,
		semanticDecisionToDispatchMs: 2,
		replacementChainActiveAtCapture: false,
		transportConfirmationMs: 6,
		hostReceiptBeforeTransportConfirmation: false,
		hostReceiptMs: 8,
		successorOutputObserved: true,
		hostInputAcceptedToOutputMs: 2,
		hostOutputToProjectionStartMs: 1,
		outputReceivedMs: 10,
		projectionStartedMs: 11,
		projectionCommittedMs: 12,
		echoTaskMs: 13,
		echoFrameMs: 14,
		frameBeforeTask: false,
		taskToFrameSchedulerActivity: {
			unitsRun: 0,
			msSpent: 0,
			terminalPresentationUnitsRun: 0,
			terminalPresentationMsSpent: 0,
		},
		echoPaintMs: 16,
		receiptToOutputMs: 2,
		outputToPaintMs: 6,
		receiptToPaintMs: 8,
		outcome: "complete",
	};
}

function appIdentity() {
	return {
		schemaVersion: 1,
		buildId: "0.1.4+abc",
		channel: "qa-test",
		generation: "generation-1",
		processId: 42,
		startedAtUnixMs: 1_788_000_000_000,
		token: "secret",
	};
}

function focusStatus() {
	return {
		controllerWindow: { exists: true, visible: false, focused: false },
		nativeWindows: {
			a: { exists: true, visible: true, focused: true },
			b: { exists: true, visible: true, focused: false },
		},
		windows: {
			a: {
				mounted: true,
				listening: true,
				synchronized: true,
				hydrating: false,
				documentFocused: true,
				terminalInputFocused: true,
				controlState: "controlling",
				webviewInstanceId: "webview-a",
				webviewStartedAt: "2026-09-02T00:00:00.000Z",
				latestSurfaceAttachmentId: "attachment-1",
			},
			b: {
				mounted: true,
				listening: true,
				synchronized: true,
				hydrating: false,
				documentFocused: false,
				terminalInputFocused: false,
			},
		},
	};
}
