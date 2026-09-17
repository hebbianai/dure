import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalViewportFrameReplica } from "@/lib/terminal/state/terminalViewportFrameReplica";
import type { TerminalReplicaTiming } from "@/lib/terminal/terminalDeliveryTimingFacts";
import type {
	StructuredTerminalViewportFrameReceipt,
	UseStructuredTerminalViewportTransportOptions,
} from "./structuredTerminalViewportTransportContract";

type ViewportFrameObserver = Pick<
	UseStructuredTerminalViewportTransportOptions,
	"onViewportFrameReceived"
>;

export function notifyViewportFrame(
	replica: TerminalViewportFrameReplica<InstalledTerminalViewportFrame>,
	observer: ViewportFrameObserver,
	deliveryTiming?: TerminalReplicaTiming,
) {
	const frame = replica.frame;
	if (!frame || replica.terminalEpoch === null) return;
	const timing = frame.frame.inputOutputTiming;
	const receipt: StructuredTerminalViewportFrameReceipt = {
		attachmentId: replica.attachmentId,
		terminalEpoch: replica.terminalEpoch,
		throughOutputSeq: replica.throughOutputSeq,
		inputOutputTiming: timing
			? {
					inputBaselineOutputSequence: timing.inputBaselineOutputSequence,
					firstOutputSequence: timing.firstOutputSequence,
					inputToOutputMicros: timing.inputToOutputMicros,
					outputToProjectionStartMicros: timing.outputToProjectionStartMicros,
					inputRecordId: timing.inputRecordId,
				}
			: null,
		...(import.meta.env.MODE === "perf" && deliveryTiming
			? { deliveryTiming }
			: {}),
	};
	observer.onViewportFrameReceived?.(receipt);
}
