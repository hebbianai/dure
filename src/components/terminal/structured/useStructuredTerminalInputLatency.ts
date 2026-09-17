import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import type { InputReceipt } from "@/contracts/terminalStateProtocol";
import {
	markTerminalOutputCommitted,
	markTerminalOutputReceived,
	type TerminalInputLatencyHandle,
	terminalInputLatency,
} from "@/lib/terminal/interaction/terminalInputLatency";
import type {
	StructuredTerminalViewportFrameReceipt,
	StructuredTerminalViewportTransport,
} from "./structuredTerminalViewportTransportContract";
import type {
	PaintedPresentation,
	TerminalProjectionTiming,
} from "./terminalCanvasPresentation";

type StructuredInputSender = StructuredTerminalViewportTransport["sendInput"];
type StructuredInputEncoder = Parameters<StructuredInputSender>[0];

interface PendingStructuredInputTrace {
	readonly recordId: bigint;
	readonly handle: TerminalInputLatencyHandle;
	readonly attachmentId: string;
	readonly terminalEpoch: string;
	readonly dispatchedThroughOutputSeq: bigint;
	hostReceiptObserved: boolean;
	transportConfirmationObserved: boolean;
	correlationSuperseded: boolean;
	outputReceived: boolean;
	outputPaintClaimed: boolean;
	outputPaintObserved: boolean;
}

interface StructuredTerminalInputLatencyOptions {
	readonly surfaceId: string;
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly observerIdRef: MutableRefObject<string | undefined>;
	readonly sendInput: StructuredInputSender;
}

/** Joins one sampled user intent to its existing semantic receipt and paint. */
export function useStructuredTerminalInputLatency({
	surfaceId,
	attachmentId,
	terminalEpoch,
	observerIdRef,
	sendInput,
}: StructuredTerminalInputLatencyOptions) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const identityRef = useRef({ attachmentId, terminalEpoch });
	const pendingRef = useRef<PendingStructuredInputTrace | null>(null);
	identityRef.current = { attachmentId, terminalEpoch };

	useEffect(() => {
		pendingRef.current = null;
		terminalInputLatency.cancelTerminal(surfaceId);
		return () => {
			pendingRef.current = null;
			terminalInputLatency.cancelTerminal(surfaceId);
		};
	}, [attachmentId, surfaceId, terminalEpoch]);

	const sendUserInput = useCallback(
		(encode: StructuredInputEncoder) => {
			const identity = identityRef.current;
			const observerId = observerIdRef.current;
			let started: PendingStructuredInputTrace | undefined;
			const encodeInput: StructuredInputEncoder = (
				candidateRecordId,
				fence,
			) => {
				if (
					observerId &&
					fence.terminalEpoch !== null &&
					observerId === identity.attachmentId &&
					identity.terminalEpoch === fence.terminalEpoch
				) {
					const handle = terminalInputLatency.beginInput({
						terminalId: surfaceId,
						...(desktopId ? { desktopId } : {}),
						fallbackSource: "input",
					});
					if (handle) {
						started = {
							recordId: candidateRecordId,
							handle,
							attachmentId: observerId,
							terminalEpoch: fence.terminalEpoch,
							dispatchedThroughOutputSeq: fence.throughOutputSeq,
							hostReceiptObserved: false,
							transportConfirmationObserved: false,
							correlationSuperseded: false,
							outputReceived: false,
							outputPaintClaimed: false,
							outputPaintObserved: false,
						};
						pendingRef.current = started;
					}
				}
				return encode(candidateRecordId, fence);
			};
			const recordId = sendInput(
				encodeInput,
				undefined,
				undefined,
				() => {
					if (started && pendingRef.current === started) {
						terminalInputLatency.markTransportConfirmation(started.handle);
						started.transportConfirmationObserved = true;
						finishCorrelationSupersededTrace(pendingRef, started);
					}
				},
				"user",
			);
			if (recordId === undefined && started && pendingRef.current === started) {
				terminalInputLatency.markFailed(started.handle);
				pendingRef.current = null;
			}
			return recordId;
		},
		[desktopId, observerIdRef, sendInput, surfaceId],
	);

	const onInputReceipt = useCallback((receipt: InputReceipt) => {
		const pending = pendingRef.current;
		const identity = identityRef.current;
		if (
			!pending ||
			pending.recordId !== receipt.inReplyToRecordId ||
			pending.attachmentId !== identity.attachmentId ||
			pending.terminalEpoch !== identity.terminalEpoch
		) {
			return;
		}
		if (receipt.outcome.case !== "writtenToPty") {
			terminalInputLatency.markFailed(pending.handle);
			pendingRef.current = null;
			return;
		}
		pending.hostReceiptObserved = true;
		terminalInputLatency.markHostReceipt(pending.handle);
		finishCorrelationSupersededTrace(pendingRef, pending);
		clearJoinedTrace(pendingRef, pending);
	}, []);

	const onViewportFrameReceived = useCallback(
		(receipt: StructuredTerminalViewportFrameReceipt) => {
			const pending = pendingRef.current;
			if (
				!pending ||
				pending.outputReceived ||
				pending.attachmentId !== receipt.attachmentId ||
				pending.terminalEpoch !== receipt.terminalEpoch ||
				receipt.throughOutputSeq <= pending.dispatchedThroughOutputSeq
			) {
				return;
			}
			terminalInputLatency.markSuccessorOutputObserved(pending.handle);
			const timing = receipt.inputOutputTiming;
			if (isLaterInputTiming(pending, receipt)) {
				pending.correlationSuperseded = true;
				finishCorrelationSupersededTrace(pendingRef, pending);
				return;
			}
			if (
				!timing ||
				timing.inputRecordId !== pending.recordId ||
				// The Host observes the authoritative output high-water at PTY
				// acceptance, which can be ahead of the last frame delivered here.
				timing.inputBaselineOutputSequence <
					pending.dispatchedThroughOutputSeq ||
				timing.firstOutputSequence <= timing.inputBaselineOutputSequence ||
				timing.firstOutputSequence > receipt.throughOutputSeq
			) {
				return;
			}
			terminalInputLatency.markHostInputOutputTiming(pending.handle, {
				inputAcceptedToOutputMs: microsToMilliseconds(
					timing.inputToOutputMicros,
				),
				outputToProjectionStartMs: microsToMilliseconds(
					timing.outputToProjectionStartMicros,
				),
			});
			pending.outputReceived = true;
			if (import.meta.env.MODE === "perf") {
				markTerminalOutputReceived(surfaceId, receipt.deliveryTiming);
			} else {
				markTerminalOutputReceived(surfaceId);
			}
		},
		[surfaceId],
	);

	const onPresentationPainted = useCallback(
		(
			presentation: PaintedPresentation,
			throughOutputSeq: bigint,
			timing: TerminalProjectionTiming,
		) => {
			const pending = pendingRef.current;
			if (
				!pending?.outputReceived ||
				pending.outputPaintClaimed ||
				pending.attachmentId !== presentation.attachmentId ||
				pending.terminalEpoch !== presentation.terminalEpoch ||
				throughOutputSeq <= pending.dispatchedThroughOutputSeq
			) {
				return;
			}
			terminalInputLatency.markProjectionCommitted(pending.handle, timing);
			const paintHandle = markTerminalOutputCommitted(
				surfaceId,
				(observedHandle) => {
					if (
						pendingRef.current !== pending ||
						!sameInputLatencyHandle(observedHandle, pending.handle)
					) {
						return;
					}
					pending.outputPaintObserved = true;
					clearJoinedTrace(pendingRef, pending);
				},
			);
			if (
				!paintHandle ||
				!sameInputLatencyHandle(paintHandle, pending.handle)
			) {
				return;
			}
			pending.outputPaintClaimed = true;
		},
		[surfaceId],
	);

	return {
		onInputReceipt,
		onPresentationPainted,
		onViewportFrameReceived,
		sendUserInput,
	};
}

function microsToMilliseconds(micros: bigint) {
	return Number(micros) / 1_000;
}

function clearJoinedTrace(
	pendingRef: MutableRefObject<PendingStructuredInputTrace | null>,
	pending: PendingStructuredInputTrace,
) {
	if (
		pendingRef.current === pending &&
		pending.hostReceiptObserved &&
		pending.outputPaintObserved
	) {
		pendingRef.current = null;
	}
}

function finishCorrelationSupersededTrace(
	pendingRef: MutableRefObject<PendingStructuredInputTrace | null>,
	pending: PendingStructuredInputTrace,
) {
	if (
		pendingRef.current !== pending ||
		!pending.hostReceiptObserved ||
		!pending.transportConfirmationObserved ||
		!pending.correlationSuperseded
	) {
		return;
	}
	terminalInputLatency.markCorrelationSuperseded(pending.handle);
	pendingRef.current = null;
}

function isLaterInputTiming(
	pending: PendingStructuredInputTrace,
	receipt: StructuredTerminalViewportFrameReceipt,
) {
	const timing = receipt.inputOutputTiming;
	return (
		timing !== null &&
		timing.inputRecordId > pending.recordId &&
		timing.inputBaselineOutputSequence >
			pending.dispatchedThroughOutputSeq &&
		timing.firstOutputSequence > timing.inputBaselineOutputSequence &&
		timing.firstOutputSequence <= receipt.throughOutputSeq
	);
}

function sameInputLatencyHandle(
	left: TerminalInputLatencyHandle,
	right: TerminalInputLatencyHandle,
) {
	return (
		left.sequence === right.sequence && left.terminalId === right.terminalId
	);
}
