import { useCallback, useRef } from "react";
import type { InputReceipt } from "@/contracts/terminalStateProtocol";
import type {
	StructuredTerminalViewportFrameReceipt,
} from "./structuredTerminalViewportTransportContract";
import type { StructuredTerminalPaneHealthPublisher } from "./useStructuredTerminalPaneHealth";

type InputReceiptObserver = (receipt: InputReceipt) => void;
type ViewportFrameObserver = (
	receipt: StructuredTerminalViewportFrameReceipt,
) => void;

/** Fan out transport receipts without making transport depend on UI consumers. */
export function useStructuredTerminalReceiptObservers(
	publishPaneHealth: StructuredTerminalPaneHealthPublisher,
) {
	const inputReceiptObserverRef = useRef<InputReceiptObserver>(undefined);
	const textInputReceiptObserverRef = useRef<InputReceiptObserver>(undefined);
	const quickCommandReceiptObserverRef = useRef<InputReceiptObserver>(undefined);
	const inputLatencyReceiptObserverRef =
		useRef<InputReceiptObserver>(undefined);
	const inputLatencyFrameObserverRef = useRef<ViewportFrameObserver>(undefined);
	const onInputReceipt = useCallback((receipt: InputReceipt) => {
		inputReceiptObserverRef.current?.(receipt);
		textInputReceiptObserverRef.current?.(receipt);
		quickCommandReceiptObserverRef.current?.(receipt);
		inputLatencyReceiptObserverRef.current?.(receipt);
	}, []);
	const onViewportFrameReceived = useCallback(
		(receipt: StructuredTerminalViewportFrameReceipt) => {
			inputLatencyFrameObserverRef.current?.(receipt);
			publishPaneHealth({
				kind: "frame_received",
				terminalEpoch: receipt.terminalEpoch,
				sequence: receipt.throughOutputSeq.toString(),
			});
		},
		[publishPaneHealth],
	);

	return {
		inputReceiptObserverRef,
		textInputReceiptObserverRef,
		quickCommandReceiptObserverRef,
		inputLatencyReceiptObserverRef,
		inputLatencyFrameObserverRef,
		onInputReceipt,
		onViewportFrameReceived,
	};
}
