import type { TerminalInputLatencySnapshot } from "@/lib/terminal/interaction/terminalInputLatency";
import { summarizeLatencyStats as stats } from "./latencyStats";
import type { WorkspacePerformanceReport } from "./workspacePerformanceReportTypes";

function measuredInterval(
	startedMs: number | null,
	completedMs: number | null,
): number[] {
	if (startedMs === null || completedMs === null || completedMs < startedMs) {
		return [];
	}
	return [completedMs - startedMs];
}

/** Projects the bounded exact input trace without reading unrelated workspace state. */
export function summarizeTerminalInputPerformance(
	snapshot: TerminalInputLatencySnapshot | null | undefined,
): WorkspacePerformanceReport["terminalInput"] {
	const terminalInput = snapshot ?? { samples: [], inFlightCount: 0 };
	const completedInputs = terminalInput.samples.filter(
		(sample) => sample.outcome === "complete",
	);
	const hostConfirmedInputs = terminalInput.samples.filter(
		(sample) => sample.hostReceiptMs !== null,
	);
	const hostConfirmedKeydowns = hostConfirmedInputs.filter(
		(sample) => sample.source === "keydown",
	);
	const completedKeydowns = completedInputs.filter(
		(sample) => sample.source === "keydown",
	);
	const summarizeKeydownDispatch = (samples: typeof hostConfirmedKeydowns) => ({
		dispatch: stats(samples.map((sample) => sample.dispatchMs)),
		captureToSemanticHandler: stats(
			samples.flatMap((sample) =>
				sample.captureToSemanticHandlerMs === null
					? []
					: [sample.captureToSemanticHandlerMs],
			),
		),
		semanticHandlerToDispatch: stats(
			samples.flatMap((sample) =>
				sample.semanticHandlerToDispatchMs === null
					? []
					: [sample.semanticHandlerToDispatchMs],
			),
		),
		semanticHandlerToDecision: stats(
			samples.flatMap((sample) =>
				sample.semanticHandlerToDecisionMs === null
					? []
					: [sample.semanticHandlerToDecisionMs],
			),
		),
		semanticDecisionToDispatch: stats(
			samples.flatMap((sample) =>
				sample.semanticDecisionToDispatchMs === null
					? []
					: [sample.semanticDecisionToDispatchMs],
			),
		),
	});
	const keydownDispatchStages = summarizeKeydownDispatch(hostConfirmedKeydowns);
	const summarizeInputOutcomes = (samples: typeof terminalInput.samples) => ({
		completedCount: samples.filter((sample) => sample.outcome === "complete")
			.length,
		correlationSupersededCount: samples.filter(
			(sample) => sample.outcome === "correlation_superseded",
		).length,
		failedCount: samples.filter((sample) => sample.outcome === "failed").length,
		timedOutCount: samples.filter((sample) => sample.outcome === "timed_out")
			.length,
		timedOutAfterSuccessorOutputCount: samples.filter(
			(sample) =>
				sample.outcome === "timed_out" && sample.successorOutputObserved,
		).length,
		timedOutWithoutSuccessorCount: samples.filter(
			(sample) =>
				sample.outcome === "timed_out" && !sample.successorOutputObserved,
		).length,
	});
	const summarizeInputSource = (source: "keydown" | "input") => {
		const samples = terminalInput.samples.filter(
			(sample) => sample.source === source,
		);
		const completed = samples.filter((sample) => sample.outcome === "complete");
		return {
			...summarizeInputOutcomes(samples),
			dispatchToTransportConfirmation: stats(
				samples.flatMap((sample) =>
					measuredInterval(sample.dispatchMs, sample.transportConfirmationMs),
				),
			),
			transportConfirmationToHostReceipt: stats(
				samples.flatMap((sample) =>
					measuredInterval(
						sample.transportConfirmationMs,
						sample.hostReceiptMs,
					),
				),
			),
			hostReceiptBeforeTransportConfirmationCount: samples.filter(
				(sample) => sample.hostReceiptBeforeTransportConfirmation === true,
			).length,
			hostAcceptedToOutput: stats(
				completed.flatMap((sample) =>
					sample.hostInputAcceptedToOutputMs === null
						? []
						: [sample.hostInputAcceptedToOutputMs],
				),
			),
			projectionCommitToTask: stats(
				completed.flatMap((sample) =>
					sample.frameBeforeTask === true
						? []
						: measuredInterval(sample.projectionCommittedMs, sample.echoTaskMs),
				),
			),
			taskToFrame: stats(
				completed.flatMap((sample) =>
					sample.frameBeforeTask === true
						? []
						: measuredInterval(sample.echoTaskMs, sample.echoFrameMs),
				),
			),
			frameBeforeTaskCount: completed.filter(
				(sample) => sample.frameBeforeTask === true,
			).length,
			projectionCommitToFrame: stats(
				completed.flatMap((sample) =>
					measuredInterval(sample.projectionCommittedMs, sample.echoFrameMs),
				),
			),
			frameToPostPaint: stats(
				completed.flatMap((sample) =>
					measuredInterval(sample.echoFrameMs, sample.echoPaintMs),
				),
			),
			inputToEchoPaint: stats(
				completed.flatMap((sample) =>
					sample.echoPaintMs === null ? [] : [sample.echoPaintMs],
				),
			),
		};
	};

	return {
		dispatch: stats(hostConfirmedKeydowns.map((sample) => sample.dispatchMs)),
		keydownDispatchStages: {
			captureToSemanticHandler: keydownDispatchStages.captureToSemanticHandler,
			semanticHandlerToDispatch:
				keydownDispatchStages.semanticHandlerToDispatch,
			semanticHandlerToDecision:
				keydownDispatchStages.semanticHandlerToDecision,
			semanticDecisionToDispatch:
				keydownDispatchStages.semanticDecisionToDispatch,
			byReplacementState: {
				inactive: summarizeKeydownDispatch(
					hostConfirmedKeydowns.filter(
						(sample) => sample.replacementChainActiveAtCapture === false,
					),
				),
				active: summarizeKeydownDispatch(
					hostConfirmedKeydowns.filter(
						(sample) => sample.replacementChainActiveAtCapture === true,
					),
				),
				unknown: summarizeKeydownDispatch(
					hostConfirmedKeydowns.filter(
						(sample) =>
							typeof sample.replacementChainActiveAtCapture !== "boolean",
					),
				),
			},
		},
		keydownToHostReceipt: stats(
			hostConfirmedKeydowns.flatMap((sample) =>
				sample.hostReceiptMs === null ? [] : [sample.hostReceiptMs],
			),
		),
		keydownToEchoPaint: stats(
			completedKeydowns.flatMap((sample) =>
				sample.echoPaintMs === null ? [] : [sample.echoPaintMs],
			),
		),
		hostReceiptToEchoPaint: stats(
			completedKeydowns.flatMap((sample) =>
				sample.receiptToPaintMs === null ? [] : [sample.receiptToPaintMs],
			),
		),
		inputToHostReceipt: stats(
			terminalInput.samples.flatMap((sample) =>
				sample.hostReceiptMs === null ? [] : [sample.hostReceiptMs],
			),
		),
		inputDispatchToTransportConfirmation: stats(
			terminalInput.samples.flatMap((sample) =>
				measuredInterval(sample.dispatchMs, sample.transportConfirmationMs),
			),
		),
		inputTransportConfirmationToHostReceipt: stats(
			terminalInput.samples.flatMap((sample) =>
				measuredInterval(sample.transportConfirmationMs, sample.hostReceiptMs),
			),
		),
		inputHostReceiptBeforeTransportConfirmationCount:
			terminalInput.samples.filter(
				(sample) => sample.hostReceiptBeforeTransportConfirmation === true,
			).length,
		inputHostAcceptedToOutput: stats(
			completedInputs.flatMap((sample) =>
				sample.hostInputAcceptedToOutputMs === null
					? []
					: [sample.hostInputAcceptedToOutputMs],
			),
		),
		inputHostOutputToProjectionStart: stats(
			completedInputs.flatMap((sample) =>
				sample.hostOutputToProjectionStartMs === null
					? []
					: [sample.hostOutputToProjectionStartMs],
			),
		),
		inputToOutputReceived: stats(
			completedInputs.flatMap((sample) =>
				sample.outputReceivedMs === null ? [] : [sample.outputReceivedMs],
			),
		),
		inputReceiptToOutputReceived: stats(
			completedInputs.flatMap((sample) =>
				sample.receiptToOutputMs === null ? [] : [sample.receiptToOutputMs],
			),
		),
		inputToEchoPaint: stats(
			completedInputs.flatMap((sample) =>
				sample.echoPaintMs === null ? [] : [sample.echoPaintMs],
			),
		),
		inputOutputToEchoPaint: stats(
			completedInputs.flatMap((sample) =>
				sample.outputToPaintMs === null ? [] : [sample.outputToPaintMs],
			),
		),
		inputOutputToProjectionStart: stats(
			completedInputs.flatMap((sample) =>
				measuredInterval(sample.outputReceivedMs, sample.projectionStartedMs),
			),
		),
		inputProjectionWork: stats(
			completedInputs.flatMap((sample) =>
				measuredInterval(
					sample.projectionStartedMs,
					sample.projectionCommittedMs,
				),
			),
		),
		inputProjectionCommitToTask: stats(
			completedInputs.flatMap((sample) =>
				sample.frameBeforeTask === true
					? []
					: measuredInterval(sample.projectionCommittedMs, sample.echoTaskMs),
			),
		),
		inputTaskToFrame: stats(
			completedInputs.flatMap((sample) =>
				sample.frameBeforeTask === true
					? []
					: measuredInterval(sample.echoTaskMs, sample.echoFrameMs),
			),
		),
		inputFrameBeforeTaskCount: completedInputs.filter(
			(sample) => sample.frameBeforeTask === true,
		).length,
		inputProjectionCommitToFrame: stats(
			completedInputs.flatMap((sample) =>
				measuredInterval(sample.projectionCommittedMs, sample.echoFrameMs),
			),
		),
		inputFrameToPostPaint: stats(
			completedInputs.flatMap((sample) =>
				measuredInterval(sample.echoFrameMs, sample.echoPaintMs),
			),
		),
		inputProjectionCommitToEchoPaint: stats(
			completedInputs.flatMap((sample) =>
				measuredInterval(sample.projectionCommittedMs, sample.echoPaintMs),
			),
		),
		inputReceiptToEchoPaint: stats(
			completedInputs.flatMap((sample) =>
				sample.receiptToPaintMs === null ? [] : [sample.receiptToPaintMs],
			),
		),
		bySource: {
			keydown: summarizeInputSource("keydown"),
			input: summarizeInputSource("input"),
		},
		...summarizeInputOutcomes(terminalInput.samples),
		inFlightCount: terminalInput.inFlightCount,
		recent: terminalInput.samples.slice(-24),
	};
}
